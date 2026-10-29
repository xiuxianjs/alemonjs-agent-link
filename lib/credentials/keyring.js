import { DSHError } from "../dsh/errors.js";
import { budgetRedis, groupKeyLimitDetails } from "../billing/budget.js";
import { decryptStoredKey, encryptStoredKey, encryptionKey } from "./personal.js";
import { groupStorageKey } from "./group.js";
import { createHash, randomUUID } from "node:crypto";

// src/credentials/keyring.ts
const keyringStorageKey = (scope) => {
	if (!scope.platform || !scope.userId) throw new DSHError("budget", "无法确认账号。");
	return `data:{agent-link-group-keys}:v1:ring:${createHash("sha256").update(JSON.stringify([scope.platform, scope.userId])).digest("hex")}`;
};
const readKeyring = async (scope) => {
	const raw = await (await budgetRedis()).get(keyringStorageKey(scope));
	return {
		raw: raw || "",
		ring: raw ? JSON.parse(raw) : {
			next: 1,
			keys: [],
			grants: []
		}
	};
};
const changeKeyring = async (scope, action, input) => {
	if (["add", "revoke"].includes(action) && scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}`) throw new DSHError("budget", "请在本人私聊操作。");
	if (action !== "add" && !/^[1-9][0-9]*$/u.test(input)) throw new DSHError("budget", "请使用有效编号。");
	const redis = await budgetRedis();
	const key = keyringStorageKey(scope);
	const { raw, ring } = await readKeyring(scope);
	let target = key;
	let payload = "";
	let expected = "";
	if (action === "add") {
		if (!scope.channelId.startsWith("private:") || !/^sk-[A-Za-z0-9_-]{8,240}$/u.test(input)) throw new DSHError("budget", "请私聊发送 /我的钥匙 群聊 添加 sk-你的Key。");
		ring.keys.push({
			id: ring.next++,
			value: {
				encrypted: await encryptStoredKey(key, input),
				enabled: true,
				revision: randomUUID(),
				reason: ""
			}
		});
	} else if (action === "grant") {
		if (scope.channelId.startsWith("private:")) throw new DSHError("budget", "请在目标群授权。");
		const entry = ring.keys.find((item) => item.id === Number(input));
		if (!entry) throw new DSHError("budget", "没有这个群聊钥匙编号。");
		target = groupStorageKey(scope);
		const token = randomUUID();
		const credential = decryptStoredKey(key, entry.value, scope, await encryptionKey());
		payload = JSON.stringify({
			encrypted: await encryptStoredKey(target, credential.apiKey),
			enabled: true,
			revision: randomUUID(),
			reason: "",
			grantToken: token,
			...entry.value.auth ? {
				auth: entry.value.auth,
				accountId: entry.value.accountId
			} : {}
		});
		ring.grants.push({
			id: ring.next++,
			keyId: entry.id,
			channelId: scope.channelId,
			token
		});
	} else {
		if (!scope.channelId.startsWith("private:")) throw new DSHError("budget", "授权记录仅本人私聊可管理。");
		const grant = ring.grants.find((item) => item.id === Number(input));
		if (!grant) throw new DSHError("budget", "没有这个授权记录编号。");
		target = groupStorageKey({
			...scope,
			channelId: grant.channelId
		});
		expected = grant.token;
		ring.grants = ring.grants.filter((item) => item.id !== grant.id);
	}
	const result = await redis.eval(`
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
if ARGV[3] == 'grant' then
 if redis.call('GET', KEYS[2]) then return 2 end
 redis.call('SET', KEYS[2], ARGV[4])
elseif ARGV[3] == 'revoke' then
 local current = redis.call('GET', KEYS[2])
 if current and cjson.decode(current).grantToken == ARGV[5] then redis.call('DEL', KEYS[2]) end
end
redis.call('SET', KEYS[1], ARGV[2])
return 1`, 2, key, target, raw, JSON.stringify(ring), action, payload, expected);
	if (Number(result) !== 1) throw new DSHError("budget", Number(result) === 2 ? "本群已有钥匙，请先移除原授权。" : "状态已变更，请重试。");
};
/** 当前群管理员移除群副本，不需要知道提供者，也不触碰个人钥匙库。 */
const removeCurrentGroupKey = async (scope) => Number(await (await budgetRedis()).del(groupStorageKey(scope))) > 0;
/** 记录保留供提供者核对，群已移除或换用另一授权时标记为失效。 */
const grantIsCurrent = async (scope, grant) => {
	const raw = await (await budgetRedis()).get(groupStorageKey({
		...scope,
		channelId: grant.channelId
	}));
	return Boolean(raw && JSON.parse(raw).grantToken === grant.token);
};
/** 只有原提供者可调整该次授权的上限；旧记录不能修改替换后的钥匙。 */
const setGrantDailyLimit = async (scope, id, input) => {
	if (scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}`) throw new DSHError("budget", "请在本人私聊操作。");
	if (!/^[1-9][0-9]*$/u.test(id) || !/^\d+(?:\.\d{1,6})?$/u.test(input) || Number(input) > 1e4) throw new DSHError("budget", "请使用记录编号和 0–10000 元的每日上限。");
	const { ring } = await readKeyring(scope);
	const grant = ring.grants.find((item) => item.id === Number(id));
	if (!grant) throw new DSHError("budget", "没有这个授权记录。");
	const changed = await (await budgetRedis()).eval(`
local raw=redis.call('GET', KEYS[1])
if not raw then return 0 end
local value=cjson.decode(raw)
if value.grantToken ~= ARGV[1] then return 0 end
value.donorDailyLimit=tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(value))
return 1`, 1, groupStorageKey({
		...scope,
		channelId: grant.channelId
	}), grant.token, input);
	if (Number(changed) !== 1) throw new DSHError("budget", "授权已失效，不能修改新钥匙。");
};
const grantLimitDetails = async (scope, grant) => {
	const target = {
		...scope,
		channelId: grant.channelId
	};
	const raw = await (await budgetRedis()).get(groupStorageKey(target));
	if ((raw ? JSON.parse(raw) : null)?.grantToken !== grant.token) return null;
	const details = await groupKeyLimitDetails(target);
	const latest = await (await budgetRedis()).get(groupStorageKey(target));
	if (!latest || JSON.parse(latest).grantToken !== grant.token) return null;
	return details;
};

export { changeKeyring, grantIsCurrent, grantLimitDetails, keyringStorageKey, readKeyring, removeCurrentGroupKey, setGrantDailyLimit };