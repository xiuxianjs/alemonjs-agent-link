import { DSHError } from "../dsh/errors.js";
import { budgetRedis, getBudgetScope } from "../billing/budget.js";
import { checkCredentialBalance, decryptStoredKey, encryptStoredKey, encryptionKey } from "./personal.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfigValue } from "alemonjs";

// src/credentials/group.ts
const prefix = "data:{agent-link-group-keys}:v1";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyFor = (scope) => {
	if (!scope.platform || !scope.channelId || scope.channelId.startsWith("private:")) throw new DSHError("budget", "无法确定目标群。");
	return `${prefix}:group:${hash([scope.platform, scope.channelId])}`;
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
	keyFor(requester);
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
	const storageKey = keyFor(target);
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
const groupKeyStatus = async (scope) => {
	const raw = await (await budgetRedis()).get(keyFor(scope));
	const value = raw ? JSON.parse(raw) : null;
	return {
		bound: Boolean(value),
		enabled: value?.enabled === true,
		reason: value?.reason || ""
	};
};
const updateGroupKey = async (scope, revision) => {
	return Number(await (await budgetRedis()).eval(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.revision ~= ARGV[1] then return 0 end
value.enabled = false
value.reason = 'balance'
value.revision = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(value))
return 1`, 1, keyFor(scope), revision, randomUUID())) === 1;
};
const getGroupCredential = async () => {
	const scope = getBudgetScope();
	if (!scope?.channelId || scope.channelId.startsWith("private:")) return null;
	if (!getConfigValue()?.db?.redis) return null;
	const key = await encryptionKey();
	if (!key) return null;
	const raw = await (await budgetRedis()).get(keyFor(scope));
	const value = raw ? JSON.parse(raw) : null;
	if (value?.enabled !== true) return null;
	if (!key) throw new DSHError("budget", "群密钥加密文件缺失，请联系主人恢复或重新绑定。");
	return decryptStoredKey(keyFor(scope), value, scope, key);
};
const checkedGroupCredential = async (signal) => checkCredentialBalance(await getGroupCredential(), (credential) => updateGroupKey(credential.scope, credential.revision), getGroupCredential, signal);

export { checkedGroupCredential, getGroupCredential, groupKeyStatus, issueGroupKeyCode, redeemGroupKeyCode, updateGroupKey };