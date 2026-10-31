import { budgetRedis, getBudgetScope } from "../billing/budget.js";
import { decryptStoredKey, encryptStoredKey, encryptionKey, personalStorageKey } from "./personal.js";
import { groupStorageKey, resolveGrantScope } from "./group.js";
import { keyringStorageKey, readKeyring } from "./keyring.js";
import { createHash, randomUUID } from "node:crypto";

// src/credentials/account.ts
const accountId = (scope) => {
	personalStorageKey(scope);
	return createHash("sha256").update(JSON.stringify([scope.platform, scope.userId])).digest("hex");
};
/** Atomically prepare two purposes; never grant a group or overwrite an existing private key. */
async function saveAccount(scope, token) {
	const owner = accountId(scope);
	const key = keyringStorageKey(scope);
	const { raw, ring } = await readKeyring(scope);
	if (ring.account) throw new Error("account-already-prepared");
	const make = async (aad) => ({
		owner: {
			platform: scope.platform,
			userId: scope.userId
		},
		encrypted: await encryptStoredKey(aad, token),
		auth: "account",
		accountId: owner,
		enabled: true,
		revision: randomUUID(),
		reason: ""
	});
	const groupId = ring.next++;
	ring.account = await make(key);
	ring.keys.push({
		id: groupId,
		value: await make(key)
	});
	const personal = await make(personalStorageKey(scope));
	const result = await (await budgetRedis()).eval(`
if (redis.call('GET',KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('SET',KEYS[1],ARGV[2])
redis.call('SET',KEYS[2],ARGV[3],'NX')
return 1`, 2, key, personalStorageKey(scope), raw, JSON.stringify(ring), JSON.stringify(personal));
	if (Number(result) !== 1) throw new Error("account-concurrent-change");
	return groupId;
}
async function getAccount(scope = getBudgetScope()) {
	if (!scope?.channelId.startsWith("private:")) return null;
	accountId(scope);
	const { ring } = await readKeyring(scope);
	if (!ring.account) return null;
	return decryptStoredKey(keyringStorageKey(scope), ring.account, scope, await encryptionKey());
}
/** Explicit account sign-out removes only this account's entries and current grant copies. */
async function removeAccount(scope) {
	const owner = accountId(scope);
	const { raw, ring } = await readKeyring(scope);
	if (!ring.account) return;
	const credential = decryptStoredKey(keyringStorageKey(scope), ring.account, scope, await encryptionKey());
	const ids = new Set(ring.keys.filter((entry) => entry.value.accountId === owner).map((entry) => entry.id));
	const grants = ring.grants.filter((grant) => ids.has(grant.keyId));
	ring.keys = ring.keys.filter((entry) => !ids.has(entry.id));
	ring.grants = ring.grants.filter((grant) => !ids.has(grant.keyId));
	delete ring.account;
	const keys = [
		keyringStorageKey(scope),
		personalStorageKey(scope),
		...await Promise.all(grants.map(async (grant) => groupStorageKey(await resolveGrantScope({
			...scope,
			channelId: grant.channelId
		}, grant.token)))),
		...grants.map((grant) => `${groupStorageKey({
			...scope,
			channelId: grant.channelId
		})}:pool`)
	];
	const result = await (await budgetRedis()).eval(`
if (redis.call('GET',KEYS[1]) or '') ~= ARGV[1] then return 0 end
local p=redis.call('GET',KEYS[2])
if p and cjson.decode(p).accountId == ARGV[3] then redis.call('DEL',KEYS[2]) end
local tokens=cjson.decode(ARGV[4])
for i=3,2+#tokens do
 local current=redis.call('GET',KEYS[i])
 if not current or cjson.decode(current).grantToken == tokens[i-2] then
  redis.call('DEL',KEYS[i])
  redis.call('LREM',KEYS[i+#tokens],0,tokens[i-2])
 end
end
redis.call('SET',KEYS[1],ARGV[2])
return 1`, keys.length, ...keys, raw, JSON.stringify(ring), owner, JSON.stringify(grants.map((grant) => grant.token)));
	if (Number(result) !== 1) throw new Error("account-concurrent-change");
	const response = await fetch("https://platform.deepseek.com/auth-api/v0/users/logout", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-dsh-auth-token": credential.apiKey
		},
		body: "{}",
		redirect: "error",
		signal: AbortSignal.timeout(15e3)
	});
	const data = response.ok ? await response.json().catch(() => null) : null;
	if (!response.ok || data?.code !== 0 || data?.data?.biz_code !== 0) throw new Error("remote-logout-unconfirmed");
}

export { accountId, getAccount, removeAccount, saveAccount };