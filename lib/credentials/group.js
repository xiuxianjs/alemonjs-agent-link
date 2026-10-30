import { DSHError } from "../dsh/errors.js";
import { budgetRedis, getBudgetScope } from "../billing/budget.js";
import { checkCredentialBalance, decryptStoredKey, encryptStoredKey, encryptionKey } from "./personal.js";
import { getConfigValue } from "alemonjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";

// src/credentials/group.ts
const prefix = "data:{agent-link-group-keys}:v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const groupStorageKey = (scope) => {
	if (!scope.platform || !scope.channelId || scope.channelId.startsWith("private:")) throw new DSHError("budget", "无法确定目标群。");
	return `${prefix}:group:${hash([scope.platform, scope.channelId])}${scope.credentialId ? `:grant:${scope.credentialId}` : ""}`;
};
const proofKey = (code) => `${prefix}:proof:${hash(code.toLowerCase())}`;
const usedKey = (code) => `${prefix}:used:${hash(code.toLowerCase())}`;
const fail = () => new DSHError("budget", "临时码无效、已过期或不属于当前账号及操作。请由群管理员在群里重新申请。");
const issueGroupKeyCode = async (requester, action) => {
	if (requester.isPrivate || !requester.isAdmin) throw new DSHError("budget", "只有本群管理员可以在群里申请临时码。");
	if (!requester.userId || !requester.messageId || ![
		"bind",
		"enable",
		"disable",
		"remove"
	].includes(action)) throw fail();
	groupStorageKey(requester);
	const redis = await budgetRedis();
	const code = randomBytes(12).toString("hex");
	const slot = `${prefix}:slot:${hash([
		requester.platform,
		requester.channelId,
		requester.userId
	])}`;
	const receipt = `${prefix}:issue:${hash([
		requester.platform,
		requester.channelId,
		requester.userId,
		requester.messageId
	])}`;
	const value = String(await redis.eval(`
local previous = redis.call('GET', KEYS[3])
if previous then
 local old = cjson.decode(previous)
 if old.action ~= ARGV[4] then return 'conflict' end
 return previous
end
local oldProof = redis.call('GET', KEYS[2])
if oldProof then redis.call('DEL', oldProof) end
local expiresAt = tonumber(redis.call('TIME')[1]) + 300
local proof = cjson.encode({platform=ARGV[1], channelId=ARGV[2], userId=ARGV[3], action=ARGV[4], expiresAt=expiresAt})
local receipt = cjson.encode({code=ARGV[5], action=ARGV[4], expiresAt=expiresAt})
redis.call('SET', KEYS[1], proof, 'EX', 300)
redis.call('SET', KEYS[2], KEYS[1], 'EX', 300)
redis.call('SET', KEYS[3], receipt, 'EX', 300)
return receipt`, 3, proofKey(code), slot, receipt, requester.platform, requester.channelId, requester.userId, action, code));
	if (value === "conflict") throw fail();
	return JSON.parse(value);
};
const redeemGroupKeyCode = async (scope, code, action, apiKey) => {
	if (!scope.userId || scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}` || !/^[a-f0-9]{24}$/iu.test(code)) throw fail();
	if (action === "bind" ? !/^sk-[A-Za-z0-9_-]{8,240}$/u.test(apiKey || "") : apiKey !== void 0) throw new DSHError("budget", "请检查指令和 DeepSeek Key 格式。");
	const redis = await budgetRedis();
	const raw = await redis.get(proofKey(code));
	const previous = raw ? null : await redis.get(usedKey(code));
	const proof = raw || previous ? JSON.parse(raw || previous) : null;
	if (proof?.platform !== scope.platform || proof.userId !== scope.userId || proof.action !== action) throw fail();
	if (previous) return {
		channelId: proof.channelId,
		action,
		duplicate: true
	};
	const target = {
		platform: proof.platform,
		channelId: proof.channelId
	};
	const storageKey = groupStorageKey(target);
	const record = {
		encrypted: action === "bind" ? await encryptStoredKey(storageKey, apiKey) : "",
		enabled: true,
		revision: randomUUID(),
		reason: ""
	};
	const result = String(await redis.eval(`
local raw = redis.call('GET', KEYS[1])
if not raw then
 local used = redis.call('GET', KEYS[3])
 if used and used == ARGV[1] then return 'duplicate' end
 return 'invalid'
end
if raw ~= ARGV[1] then return 'invalid' end
local proof = cjson.decode(raw)
if proof.platform ~= ARGV[2] or proof.userId ~= ARGV[3] or proof.action ~= ARGV[4] then return 'invalid' end
if proof.expiresAt <= tonumber(redis.call('TIME')[1]) then return 'invalid' end
if ARGV[4] == 'bind' then
 redis.call('SET', KEYS[2], ARGV[5])
elseif ARGV[4] == 'remove' then
 redis.call('DEL', KEYS[2])
else
 local current = redis.call('GET', KEYS[2])
 if not current then return 'unbound' end
 local value = cjson.decode(current)
 value.enabled = ARGV[4] == 'enable'
 value.reason = value.enabled and '' or 'manual'
 value.revision = ARGV[6]
 redis.call('SET', KEYS[2], cjson.encode(value))
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[3], raw, 'EX', 300)
return 'ok'`, 3, proofKey(code), storageKey, usedKey(code), raw, scope.platform, scope.userId, action, JSON.stringify(record), randomUUID()));
	if (result === "unbound") throw new DSHError("budget", "该群尚未绑定 Key，请先申请绑定码。");
	if (!["ok", "duplicate"].includes(result)) throw fail();
	return {
		channelId: proof.channelId,
		action,
		duplicate: result === "duplicate"
	};
};
/** Root record is retained for existing installations; new grants have independent slots. */
const groupCredentialScopes = async (scope) => {
	const root = {
		...scope,
		credentialId: void 0
	};
	const ids = await (await budgetRedis()).lrange(`${groupStorageKey(root)}:pool`, 0, -1);
	return [root, ...Array.from(new Set(ids)).map((credentialId) => ({
		...root,
		credentialId
	}))];
};
const resolveGrantScope = async (scope, token) => {
	const target = {
		...scope,
		credentialId: token
	};
	const redis = await budgetRedis();
	if (await redis.exists(groupStorageKey(target))) return target;
	const legacy = {
		...scope,
		credentialId: void 0
	};
	const raw = await redis.get(groupStorageKey(legacy));
	return raw && JSON.parse(raw).grantToken === token ? legacy : target;
};
const credentialStateLabel = (value) => value.enabled ? "已启用，调用时校验" : value.reason === "auth" ? "认证失败，需修复授权后启用" : value.reason === "balance" ? "余额不足，充值后启用" : "手动停用";
const groupKeyEntries = async (scope) => {
	const redis = await budgetRedis();
	return (await Promise.all((await groupCredentialScopes(scope)).map(async (target) => {
		const raw = await redis.get(groupStorageKey(target));
		if (!raw) return null;
		const value = JSON.parse(raw);
		return {
			scope: target,
			enabled: value.enabled,
			reason: value.reason,
			label: credentialStateLabel(value)
		};
	}))).filter((value) => value !== null);
};
const groupKeyStatus = async (scope) => {
	const redis = await budgetRedis();
	const values = (await Promise.all((await groupCredentialScopes(scope)).map(async (target) => {
		const raw = await redis.get(groupStorageKey(target));
		return raw ? JSON.parse(raw) : null;
	}))).filter((value) => Boolean(value));
	return {
		bound: values.length > 0,
		enabled: values.some((value) => value.enabled),
		count: values.length,
		active: values.filter((value) => value.enabled).length,
		reason: values.find((value) => value.reason)?.reason || ""
	};
};
const updateGroupKey = async (scope, revision, reason = "balance") => {
	return Number(await (await budgetRedis()).eval(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.revision ~= ARGV[1] then return 0 end
value.enabled = false
value.reason = ARGV[3]
value.revision = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(value))
return 1`, 1, groupStorageKey(scope), revision, randomUUID(), reason)) === 1;
};
const getGroupCredential = async () => {
	const scope = getBudgetScope();
	if (!scope?.channelId || scope.channelId.startsWith("private:")) return null;
	if (!getConfigValue()?.db?.redis) return null;
	const key = await encryptionKey();
	if (!key) return null;
	const redis = await budgetRedis();
	for (const target of await groupCredentialScopes(scope)) {
		if (scope.excludedCredentials?.includes(target.credentialId || "legacy")) continue;
		const raw = await redis.get(groupStorageKey(target));
		const value = raw ? JSON.parse(raw) : null;
		if (value?.enabled === true) return decryptStoredKey(groupStorageKey(target), value, target, key);
	}
	return null;
};
const checkedGroupCredential = async (signal) => {
	for (let attempt = 0; attempt < 66; attempt++) {
		const credential = await getGroupCredential();
		if (!credential) return null;
		const checked = await checkCredentialBalance(credential, (item) => updateGroupKey(item.scope, item.revision), getGroupCredential, signal, (item) => updateGroupKey(item.scope, item.revision, "auth"));
		if (checked) return checked;
	}
	throw new DSHError("budget", "群钥匙频繁变更，请重新发送请求。");
};
const setGroupKeyState = async (scope, enabled) => {
	const keys = (await groupCredentialScopes(scope)).map(groupStorageKey);
	return Number(await (await budgetRedis()).eval(`
local count=0
for _,key in ipairs(KEYS) do
 local raw=redis.call('GET',key)
 if raw then
  local value=cjson.decode(raw)
  value.enabled=ARGV[1]=='1'
  value.reason=value.enabled and '' or 'manual'
  value.revision=ARGV[2]..key
  redis.call('SET',key,cjson.encode(value))
  count=count+1
 end
end
return count`, keys.length, ...keys, enabled ? "1" : "0", randomUUID())) > 0;
};

export { checkedGroupCredential, credentialStateLabel, getGroupCredential, groupCredentialScopes, groupKeyEntries, groupKeyStatus, groupStorageKey, issueGroupKeyCode, redeemGroupKeyCode, resolveGrantScope, setGroupKeyState, updateGroupKey };