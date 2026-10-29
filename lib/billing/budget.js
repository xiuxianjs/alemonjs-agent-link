import { DSHError } from "../dsh/errors.js";
import { assertAIEnabled } from "../dsh/ai-switch.js";
import { groupKeyGuide, insufficientBudgetHelp } from "./help.js";
import { withBalanceCheckScope } from "../credentials/balance-scope.js";
import { logger } from "alemonjs";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// src/billing/budget.ts
const context = new AsyncLocalStorage();
const getBudgetScope = () => context.getStore();
const withBudgetScope = (scope, run) => context.run(scope, () => withBalanceCheckScope(run));
const budgetEnabled = (config) => config.budget?.enabled === true;
const prefix = "data:{agent-link-budget}:v1";
const ttl = 2764800;
const units = 1e6;
const budgetDay = (ms) => new Date(ms + 288e5).toISOString().slice(0, 10);
const budgetLimit = (config, scope) => scope.channelId.startsWith("private:") ? personalLimit(config) : gateLimit(config);
const scopeHash = (scope) => createHash("sha256").update(JSON.stringify([scope.platform, scope.channelId])).digest("hex");
const reserveScript = `
local gate = ARGV[6] == 'reply-gate'
local autonomous = ARGV[6] == 'autonomous'
local observe = ARGV[6] == 'observe'
local maximum=9007199254740991
local function integer(value)
 local n=tonumber(value)
 return n and n>=0 and n<=maximum and n==math.floor(n)
end
local function invalid() return redis.error_reply('Invalid budget reservation ledger') end
-- Validate reads, types and expiry before even changing blocked notices.
for _,i in ipairs({1,2,3,4,5,7}) do
 if not integer(ARGV[i] or (i==7 and '0' or '')) then return invalid() end
end
if tonumber(ARGV[4])<1 then return invalid() end
for i,key in ipairs(KEYS) do
 if i~=3 then
  if key==KEYS[3] then return invalid() end
  local kind=redis.call('TYPE',key).ok
  if kind~='none' and kind~='hash' then return invalid() end
  for _,field in ipairs({'used','reserved','requests','pendingRequests','paidUsed','paidReserved','paidLimit','limitOverride'}) do
   local value=redis.call('HGET',key,field)
   if value and (not string.match(value,'^%d+$') or not integer(value) or string.format('%.0f',tonumber(value))~=value) then return invalid() end
  end
 end
end
if redis.call('EXISTS',KEYS[3])==1 then return 0 end
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
local wallet = KEYS[6] or KEYS[1]
local paidUsed = tonumber(redis.call('HGET', wallet, 'paidUsed') or '0')
local paidLimit = tonumber(redis.call('HGET', wallet, 'paidLimit') or '0')
local paid = math.min(amount, math.max(0, paidLimit - paidUsed))
local free = amount - paid
local total = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')
local gateTotal = gate and KEYS[5] and tonumber(redis.call('HGET', KEYS[5], 'used') or '0') or 0
local gateGlobalBlocked = gate and tonumber(ARGV[7] or '0') > 0 and gateTotal + amount > tonumber(ARGV[7])
local person = tonumber(redis.call('HGET', KEYS[4], 'used') or '0')
local limit = tonumber(redis.call('HGET', KEYS[4], 'limitOverride') or (gate and ARGV[2] or ARGV[5]))
local freeUsed = gate and person - tonumber(redis.call('HGET', KEYS[4], 'paidUsed') or '0') or person
local groupBlocked = gate and free > 0 and freeUsed + free > limit
local personBlocked = not gate and free > 0 and (autonomous or person + free > limit)
-- Aggregate aliases too: one hash can serve multiple ledger roles.
local changes={}
local function add(key,field,delta)
 changes[key]=changes[key] or {}
 changes[key][field]=(changes[key][field] or 0)+delta
end
for _,i in ipairs({1,2,4}) do
 local debit=gate and (i==1 and paid or amount) or (i==4 and free or amount)
 add(KEYS[i],'used',debit)
 add(KEYS[i],'reserved',debit)
 add(KEYS[i],'requests',1)
 add(KEYS[i],'pendingRequests',1)
end
if gate and KEYS[5] then
 add(KEYS[5],'used',amount)
 add(KEYS[5],'reserved',amount)
 add(KEYS[5],'pendingRequests',1)
end
add(wallet,'paidUsed',paid)
add(wallet,'paidReserved',paid)
if gate then add(KEYS[4],'paidUsed',paid) end
for key,fields in pairs(changes) do
 for field,delta in pairs(fields) do
  local before=tonumber(redis.call('HGET',key,field) or '0')
  if not integer(delta) or delta>maximum-before then return invalid() end
 end
end
if not observe and (groupBlocked or personBlocked or gateGlobalBlocked or (tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3]))) then
 if groupBlocked then redis.call('HSET', KEYS[4], 'blockedRequired', free) end
 if personBlocked then redis.call('HSET', KEYS[4], 'blockedRequired', free) end
 if tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3]) then redis.call('HSET', KEYS[2], 'blockedRequired', amount) end
 if gateGlobalBlocked then redis.call('HSET', KEYS[5], 'blockedRequired', amount) if (tonumber(redis.call('HGET',KEYS[5],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[5],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[5]) else redis.call('EXPIRE', KEYS[5], ARGV[4]) end end
 for _,i in ipairs({1,2,4}) do if (tonumber(redis.call('HGET',KEYS[i],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[i],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[i]) else redis.call('EXPIRE', KEYS[i], ARGV[4]) end end
 return 0
end
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
if free > 0 then redis.call('HDEL', KEYS[4], 'blockedRequired') end
redis.call('HDEL', KEYS[2], 'blockedRequired')
if gate and KEYS[5] then
 redis.call('HDEL', KEYS[5], 'blockedRequired')
 redis.call('HINCRBY', KEYS[5], 'used', string.format('%.0f',amount))
 redis.call('HINCRBY', KEYS[5], 'reserved', string.format('%.0f',amount))
 redis.call('HINCRBY', KEYS[5], 'pendingRequests', 1)
 if (tonumber(redis.call('HGET',KEYS[5],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[5],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[5]) else redis.call('EXPIRE', KEYS[5], ARGV[4]) end
end
redis.call('SET', KEYS[3], cjson.encode({amount=amount,paid=paid,gate=gate,keys=KEYS,retentionVersion=1,at=tonumber(redis.call('TIME')[1])}))
for _,i in ipairs({1,2,4}) do
 local debit = gate and (i == 1 and paid or amount) or (i == 4 and free or amount)
 redis.call('HINCRBY', KEYS[i], 'used', string.format('%.0f',debit))
 redis.call('HINCRBY', KEYS[i], 'reserved', string.format('%.0f',debit))
 redis.call('HINCRBY', KEYS[i], 'requests', 1)
 redis.call('HINCRBY', KEYS[i], 'pendingRequests', 1)
 if (tonumber(redis.call('HGET',KEYS[i],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[i],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[i]) else redis.call('EXPIRE', KEYS[i], ARGV[4]) end
end
redis.call('HINCRBY', KEYS[6] or KEYS[1], 'paidUsed', string.format('%.0f',paid))
redis.call('HINCRBY', KEYS[6] or KEYS[1], 'paidReserved', string.format('%.0f',paid))
if gate then redis.call('HINCRBY', KEYS[4], 'paidUsed', string.format('%.0f',paid)) end
return 1
`;
const settleScript = `
local raw=redis.call('GET',KEYS[3])
if not raw then return 0 end
local receipt=cjson.decode(raw)
local maximum=9007199254740991
local function integer(value)
 local n=tonumber(value)
 return n and n>=0 and n<=maximum and n==math.floor(n)
end
if not integer(receipt.amount) or not integer(receipt.paid) or receipt.paid>receipt.amount then return -1 end
for i=1,4 do if not integer(ARGV[i]) then return -1 end end
local actual=tonumber(ARGV[1])
local paid=math.min(actual,receipt.paid)
local changes={}
local function add(key,field,delta)
 changes[key]=changes[key] or {}
 changes[key][field]=(changes[key][field] or 0)+delta
end
for _,i in ipairs({1,2,4}) do
 local before=receipt.gate and (i==1 and receipt.paid or receipt.amount) or (i==4 and receipt.amount-receipt.paid or receipt.amount)
 local after=receipt.gate and (i==1 and paid or actual) or (i==4 and actual-paid or actual)
 add(KEYS[i],'used',after-before)
 add(KEYS[i],'reserved',-before)
 add(KEYS[i],'promptTokens',tonumber(ARGV[2]))
 add(KEYS[i],'completionTokens',tonumber(ARGV[3]))
 add(KEYS[i],'cacheHitTokens',tonumber(ARGV[4]))
 add(KEYS[i],'settled',1)
 if receipt.retentionVersion==1 then add(KEYS[i],'pendingRequests',-1) end
end
add(KEYS[6] or KEYS[1],'paidUsed',paid-receipt.paid)
add(KEYS[6] or KEYS[1],'paidReserved',-receipt.paid)
if receipt.gate then add(KEYS[4],'paidUsed',paid-receipt.paid) end
if receipt.gate and KEYS[5] then
 add(KEYS[5],'used',actual-receipt.amount)
 add(KEYS[5],'reserved',-receipt.amount)
 if receipt.retentionVersion==1 then add(KEYS[5],'pendingRequests',-1) end
end
-- Validate every affected field and final value BEFORE the first mutation.
for key,fields in pairs(changes) do
 if redis.call('TYPE',key).ok~='hash' then return -1 end
 for field,delta in pairs(fields) do
  local text=redis.call('HGET',key,field) or '0'
  if not string.match(text,'^%d+$') or not integer(text) or string.format('%.0f',tonumber(text))~=text or not integer(tonumber(text)+delta) then return -1 end
 end
end
for key,fields in pairs(changes) do
 for field,delta in pairs(fields) do redis.call('HINCRBY',key,field,string.format('%.0f',delta)) end
 if key~=KEYS[6] then
  if tonumber(redis.call('HGET',key,'pendingRequests') or '0')>0 or tonumber(redis.call('HGET',key,'reserved') or '0')>0 or tonumber(redis.call('HGET',key,'paidReserved') or '0')>0 then redis.call('PERSIST',key)
  else redis.call('EXPIRE',key,2764800) end
 end
end
redis.call('SET',KEYS[3]..':audit',cjson.encode({operator=ARGV[5] or 'automatic',actual=actual,reserved=receipt.amount,at=tonumber(redis.call('TIME')[1])}),'EX',7776000)
redis.call('DEL',KEYS[3])
return 1
`;
const bounded = async (work) => {
	let timer;
	try {
		return await Promise.race([work, new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("Redis timeout")), 3e3);
		})]);
	} catch {
		throw new DSHError("budget", "额度统计暂时不可用，已暂停付费调用，请联系主人检查 Redis。");
	} finally {
		clearTimeout(timer);
	}
};
const budgetRedis = async () => {
	const { getIoRedis } = await import("@alemonjs/db");
	const redis = getIoRedis({
		connectTimeout: 3e3,
		maxRetriesPerRequest: 1
	});
	if (redis.status !== "ready") await bounded(new Promise((resolve, reject) => {
		const ready = () => {
			cleanup();
			resolve();
		};
		const error = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Redis unavailable"));
		};
		const cleanup = () => {
			redis.off("ready", ready);
			redis.off("error", error);
		};
		redis.once("ready", ready);
		redis.once("error", error);
		setTimeout(() => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Redis timeout"));
		}, 3e3).unref();
	}));
	await bounded(redis.ping());
	return redis;
};
const keysFor = (day, scope) => [`${prefix}:${day}:${scopeHash(scope)}`, `${prefix}:${day}:all`];
const redisDay = async (redis) => budgetDay(Number((await bounded(redis.time()))[0]) * 1e3);
const walletKey = (scope) => `${prefix}:wallet:${scopeHash(scope)}`;
const walletMigrationScript = `
if redis.call('HEXISTS', KEYS[1], 'initialized') == 0 and tonumber(redis.call('HGET', KEYS[2], 'paidReserved') or '0') > 0 then return 0 end
if redis.call('HSETNX', KEYS[1], 'initialized', '1') == 1 then
 local limit = tonumber(redis.call('HGET', KEYS[2], 'paidLimit') or '0')
 local used = tonumber(redis.call('HGET', KEYS[2], 'paidUsed') or '0')
 redis.call('HSET', KEYS[1], 'paidLimit', math.max(0, limit-used), 'paidUsed', '0')
end
return 1`;
const ensureWallet = async (redis, day, scope) => {
	const key = walletKey(scope);
	await redis.set(`${prefix}:wallet-migration-day`, day, "NX");
	const migrationDay = await redis.get(`${prefix}:wallet-migration-day`);
	const migrated = await bounded(redis.eval(walletMigrationScript, 2, key, keysFor(migrationDay, scope)[0]));
	if (Number(migrated) !== 1) throw new DSHError("budget", "旧充值账本仍有待结算请求，请完成结算后重试。");
	return key;
};
const personalLimit = (config) => Math.floor((config.budget?.personalDailyYuan ?? config.budget?.privateDailyYuan ?? 1) * units);
const personalKey = (day, scope) => {
	if (!scope.userId) throw new DSHError("budget", "无法确定本次调用所属用户，已暂停付费调用。");
	return `${prefix}:${day}:person:${scopeHash({
		platform: scope.platform,
		channelId: scope.userId
	})}`;
};
const gateLimit = (config) => Math.floor((config.budget?.replyGateDailyYuan ?? 1) * units);
const gateKey = (day, scope) => `${prefix}:${day}:gate:${scopeHash(scope)}`;
const privateUserScope = (scope) => {
	try {
		const [platform, userId] = JSON.parse(scope.channelId.slice(8));
		if (platform === scope.platform && typeof userId === "string" && userId && scope.channelId === `private:${JSON.stringify([platform, userId])}`) return {
			...scope,
			userId
		};
	} catch {}
	throw new DSHError("budget", "无法确定私聊额度所属用户。");
};
const requestKeys = (day, scope, kind = "chat") => [
	...keysFor(day, scope),
	`${prefix}:${day}:request:${randomUUID()}`,
	kind === "reply-gate" ? gateKey(day, scope) : kind === "autonomous" || scope.autonomous ? `${prefix}:${day}:autonomous:${scopeHash(scope)}` : personalKey(day, scope),
	`${prefix}:${day}:gate-all`,
	walletKey(scope)
];
/**
* 唯一的额度判定入口，0 元表示“不设上限”，只有显式 > 0 才参与比较。
* 分开判断全局与个人两本账，错误文案才能说清是哪一项用满。
*/
const budgetBlockReason = (state) => {
	if (state.globalLimit > 0 && (state.globalUsed >= state.globalLimit || state.globalUsed + state.globalRequired > state.globalLimit)) return "global";
	if (state.available <= 0 || state.required > 0 && state.available < state.required) return "personal";
	return "none";
};
const budgetStatus = async (config, scope) => {
	if (scope.channelId.startsWith("private:")) scope = privateUserScope(scope);
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const [key, totalKey] = keysFor(day, scope);
	const wallet = await ensureWallet(redis, day, scope);
	const [value, total, person, paid] = await bounded(Promise.all([
		redis.hgetall(key),
		redis.hgetall(totalKey),
		scope.userId ? redis.hgetall(personalKey(day, scope)) : Promise.resolve({}),
		redis.hgetall(wallet)
	]));
	const freeLimit = person.limitOverride === void 0 ? personalLimit(config) : Number(person.limitOverride);
	const used = Number(value.used || 0);
	const paidUsed = Number(paid.paidUsed || 0);
	const paidLimit = Number(paid.paidLimit || 0);
	const paidRemaining = Math.max(0, paidLimit - paidUsed);
	const personUsed = Number(person.used || 0);
	const personRemaining = scope.userId && !scope.autonomous ? Math.max(0, freeLimit - personUsed) : 0;
	const globalUsed = Number(total.used || 0);
	const globalLimit = Math.floor((config.budget?.globalDailyYuan ?? 0) * units);
	const available = paidRemaining + personRemaining;
	const reason = budgetBlockReason({
		available,
		required: Number(person.blockedRequired || 0),
		globalLimit,
		globalUsed,
		globalRequired: Number(total.blockedRequired || 0)
	});
	return {
		day,
		reason,
		blocked: reason !== "none",
		limit: (freeLimit + paidLimit) / units,
		defaultLimit: personalLimit(config) / units,
		freeLimit: freeLimit / units,
		freeUsed: personUsed / units,
		freeRemaining: personRemaining / units,
		paidLimit: paidLimit / units,
		paidUsed: paidUsed / units,
		paidRemaining: paidRemaining / units,
		personalLimit: freeLimit / units,
		personalUsed: personUsed / units,
		personalRemaining: personRemaining / units,
		personalReserved: Number(person.reserved || 0) / units,
		used: used / units,
		remaining: available / units,
		available: available / units,
		reserved: Number(value.reserved || 0) / units,
		requests: Number(value.requests || 0),
		promptTokens: Number(value.promptTokens || 0),
		completionTokens: Number(value.completionTokens || 0),
		cacheHitTokens: Number(value.cacheHitTokens || 0),
		globalUsed: globalUsed / units,
		globalLimit: globalLimit / units,
		blockedRequired: Number(person.blockedRequired || 0) / units
	};
};
const replyGateBudgetStatus = async (config, scope) => {
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const [, totalKey] = keysFor(day, scope);
	const [gate, group, total, gateTotal] = await bounded(Promise.all([
		redis.hgetall(gateKey(day, scope)),
		redis.hgetall(await ensureWallet(redis, day, scope)),
		redis.hgetall(totalKey),
		redis.hgetall(`${prefix}:${day}:gate-all`)
	]));
	const used = Number(gate.used || 0);
	const paidUsed = Number(gate.paidUsed || 0);
	const limit = gate.limitOverride === void 0 ? gateLimit(config) : Number(gate.limitOverride);
	const freeRemaining = Math.max(0, limit - (used - paidUsed));
	const paidRemaining = Math.max(0, Number(group.paidLimit || 0) - Number(group.paidUsed || 0));
	const available = freeRemaining + paidRemaining;
	const globalLimit = Math.floor((config.budget?.globalDailyYuan ?? 0) * units);
	const gateGlobalLimit = Math.floor((config.budget?.replyGateGlobalDailyYuan ?? 0) * units);
	const gateGlobalBlocked = gateGlobalLimit > 0 && Number(gateTotal.used || 0) + Number(gateTotal.blockedRequired || 0) >= gateGlobalLimit;
	const mainGlobalBlocked = globalLimit > 0 && (Number(total.used || 0) >= globalLimit || Number(total.used || 0) + Number(total.blockedRequired || 0) > globalLimit);
	const requiredGate = Number(gate.blockedRequired || 0);
	const reason = gateGlobalBlocked || mainGlobalBlocked ? "global" : available <= 0 || requiredGate > 0 && available < requiredGate ? "personal" : "none";
	return {
		limit: limit / units,
		used: used / units,
		freeUsed: (used - paidUsed) / units,
		freeRemaining: freeRemaining / units,
		paidUsed: paidUsed / units,
		paidRemaining: paidRemaining / units,
		available: available / units,
		reserved: Number(gate.reserved || 0) / units,
		globalUsed: Number(gateTotal.used || 0) / units,
		globalLimit: gateGlobalLimit / units,
		blockedRequired: Number(gate.blockedRequired || 0) / units,
		reason,
		blocked: reason !== "none"
	};
};
const parseUsage = (value) => {
	if (!value || typeof value !== "object") return;
	const v = value;
	const hit = v.prompt_cache_hit_tokens ?? v.prompt_tokens_details?.cached_tokens ?? 0;
	if (![
		v.prompt_tokens,
		v.completion_tokens,
		hit
	].every((n) => Number.isSafeInteger(n) && n >= 0) || hit > v.prompt_tokens) return;
	return {
		prompt_tokens: v.prompt_tokens,
		completion_tokens: v.completion_tokens,
		prompt_cache_hit_tokens: hit
	};
};
const officialRates = (url, model) => {
	if (url.origin !== "https://api.deepseek.com" || !["/chat/completions", "/v1/chat/completions"].includes(url.pathname) || url.search || url.hash) throw new DSHError("budget", "当前服务商尚未配置可核验的价格，已暂停付费调用。");
	if ([
		"deepseek-flash",
		"deepseek-v4-flash",
		"deepseek-v4-flash-vision-exp"
	].includes(model)) return {
		input: 2,
		output: 8,
		cached: .04
	};
	if (model === "deepseek-v4-pro") return {
		input: 9,
		output: 27,
		cached: .3
	};
	throw new DSHError("budget", "当前模型尚未配置可核验的价格，已暂停付费调用。");
};
const usageCost = (usage, rates) => Math.ceil((usage.prompt_tokens - (usage.prompt_cache_hit_tokens || 0)) * rates.input + (usage.prompt_cache_hit_tokens || 0) * rates.cached + usage.completion_tokens * rates.output);
const textBudgetInput = (body) => {
	if (!Array.isArray(body.messages)) throw new DSHError("protocol", "模型消息格式无效。");
	let hasImages = false;
	const messages = body.messages.map((message) => {
		if (!message || typeof message !== "object") throw new DSHError("protocol", "模型消息格式无效。");
		if (typeof message.content === "string" || message.content === null) return message;
		if (!Array.isArray(message.content)) throw new DSHError("protocol", "模型消息格式无效。");
		const text = [];
		for (const part of message.content) if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
		else if (part?.type === "image_url") hasImages = true;
		else throw new DSHError("protocol", "模型消息包含不支持的内容类型。");
		return {
			...message,
			content: text.join("\n")
		};
	});
	return {
		bytes: Buffer.byteLength(JSON.stringify({
			messages,
			tools: body.tools
		})),
		hasImages
	};
};
const keyLimitScope = (scope) => ({
	platform: `key-budget:${scope.platform}`,
	userId: scope.channelId,
	channelId: `private:${JSON.stringify([`key-budget:${scope.platform}`, scope.channelId])}`
});
const groupKeyLimitDetails = async (scope, expectedRevision) => {
	const raw = await (await budgetRedis()).get(`${prefix}:key-limit:${scopeHash(scope)}`);
	const { groupStorageKey } = await import("../credentials/group.js");
	const record = await (await budgetRedis()).get(groupStorageKey(scope));
	const stored = record ? JSON.parse(record) : null;
	if (expectedRevision && (stored?.revision !== expectedRevision || stored.enabled !== true)) throw new DSHError("budget", "群钥匙已变更，请重新发送请求。");
	const donor = stored?.donorDailyLimit;
	if (raw !== null && (!/^\d+(?:\.\d{1,6})?$/u.test(raw) || Number(raw) > 1e4) || donor !== void 0 && (typeof donor !== "number" || !Number.isFinite(donor) || donor < 0 || donor > 1e4)) throw new DSHError("budget", "群钥匙预算配置无效，已暂停调用，请联系主人检查。");
	const limits = [raw === null ? void 0 : Number(raw), donor].filter((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
	return {
		donor: donor ?? null,
		group: raw === null ? null : Number(raw),
		effective: limits.length ? Math.min(...limits) : null
	};
};
const groupKeyDailyLimit = async (scope, expectedRevision) => (await groupKeyLimitDetails(scope, expectedRevision)).effective;
const setGroupKeyDailyLimit = async (scope, value) => {
	if (!scope.platform || !scope.channelId || scope.channelId.startsWith("private:")) throw new DSHError("budget", "请在目标群设置。");
	if (value === "取消") {
		await (await budgetRedis()).del(`${prefix}:key-limit:${scopeHash(scope)}`);
		return;
	}
	if (!/^\d+(?:\.\d{1,6})?$/u.test(value) || Number(value) > 1e4) throw new DSHError("budget", "每日上限为 0–10000 元，最多六位小数；0 表示暂停钥匙调用。");
	await (await budgetRedis()).set(`${prefix}:key-limit:${scopeHash(scope)}`, String(Number(value)));
};
const groupKeyBudgetStatus = async (config, scope) => {
	const limit = await groupKeyDailyLimit(scope);
	return {
		...await budgetStatus({
			...config,
			budget: {
				enabled: true,
				personalDailyYuan: limit ?? 1e9
			}
		}, keyLimitScope(scope)),
		unlimited: limit === null
	};
};
const markPendingBudget = async (redis, key, reason) => {
	await redis.eval(`local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local value=cjson.decode(raw); value.reason=ARGV[1]; redis.call('SET',KEYS[1],cjson.encode(value),'KEEPTTL'); return 1`, 1, key, reason);
};
const budgetedFetch = async (config, url, init, kind = "chat", keyBudget = false) => {
	assertAIEnabled(config);
	if (kind === "chat" && getBudgetScope()?.autonomous) kind = "autonomous";
	if (kind === "reply-gate" && getBudgetScope()?.channelId.startsWith("private:")) throw new DSHError("budget", "主动搭话识别仅限群会话。");
	if (init.personalKey && !getBudgetScope()?.channelId.startsWith("private:")) throw new DSHError("budget", "个人 Key 只能用于本人私聊。");
	const { getBoundCredential, checkedBoundCredential, disableBoundCredential } = await import("../credentials/scoped.js");
	if (!keyBudget && (init.personalKey || init.scopedKey || await getBoundCredential())) {
		const personal = await checkedBoundCredential(init.signal || void 0);
		if (personal) {
			const headers = new Headers(init.headers);
			headers.delete("Authorization");
			headers.delete("x-dsh-auth-token");
			headers.set(personal.auth === "account" ? "x-dsh-auth-token" : "Authorization", personal.auth === "account" ? personal.apiKey : `Bearer ${personal.apiKey}`);
			const groupLimit = personal.scope.channelId.startsWith("private:") ? null : await groupKeyDailyLimit(personal.scope, personal.revision);
			if (groupLimit !== null && textBudgetInput(JSON.parse(String(init.body))).hasImages) throw new DSHError("budget", "本群已设置钥匙金额上限，暂不支持无法准确预估费用的图片调用。");
			const result = !(!personal.scope.channelId.startsWith("private:") && !textBudgetInput(JSON.parse(String(init.body))).hasImages) ? await (() => {
				init.onDispatch?.();
				return fetch(new URL("https://api.deepseek.com/chat/completions"), {
					...init,
					headers,
					redirect: "error"
				});
			})() : await withBudgetScope(keyLimitScope(personal.scope), () => budgetedFetch({
				...config,
				budget: {
					enabled: true,
					personalDailyYuan: groupLimit ?? 1e9,
					maxOutputTokens: config.budget?.maxOutputTokens ?? 2048
				}
			}, new URL("https://api.deepseek.com/chat/completions"), {
				...init,
				headers,
				redirect: "error",
				personalKey: false,
				scopedKey: false,
				pricing: void 0
			}, "chat", groupLimit === null ? "observe" : true));
			if (personal.auth === "account" && [401, 403].includes(result.status)) {
				await result.body?.cancel();
				throw new DSHError("budget", "账户授权不可用，请退出后重新登录。");
			}
			if (result.status !== 402) return result;
			await result.body?.cancel();
			if (!await disableBoundCredential(personal)) throw new DSHError("budget", "绑定 Key 设置已变更，请重新发送请求。");
			throw new DSHError("budget", "钥匙余额不足，已暂停使用；充值后请启用，或显式停用、移除以使用机器人额度。");
		}
		const { getDSHCredentials } = await import("../dsh/credentials.js");
		const shared = await getDSHCredentials();
		if (!shared) throw new DSHError("budget", "绑定 Key 已停用，但机器人未配置模型凭证。");
		const headers = new Headers(init.headers);
		headers.delete("x-dsh-auth-token");
		headers.set("Authorization", `Bearer ${shared.apiKey}`);
		init = {
			...init,
			headers
		};
		url = new URL(`${(shared.baseUrl || "https://api.deepseek.com").replace(/\/+$/u, "")}/chat/completions`);
	}
	if (!budgetEnabled(config)) {
		init.onDispatch?.();
		return fetch(url, init);
	}
	init.signal?.throwIfAborted();
	const scope = context.getStore();
	if (!scope?.channelId || !scope.platform) throw new DSHError("budget", "无法确定本次调用所属会话，已暂停付费调用。");
	if (kind === "reply-gate" && scope.channelId.startsWith("private:")) throw new DSHError("budget", "主动搭话识别仅限群会话。");
	const body = JSON.parse(String(init.body));
	const rates = init.pricing || officialRates(url, body.model);
	const textInput = textBudgetInput(body);
	const maxOutput = keyBudget === "observe" && Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : Math.min(config.budget?.maxOutputTokens ?? 2048, Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : config.budget?.maxOutputTokens ?? 2048);
	if (keyBudget !== "observe") body.max_tokens = maxOutput;
	if (body.stream) body.stream_options = {
		...body.stream_options,
		include_usage: true
	};
	const promptBound = textInput.bytes + 8192;
	const amount = Math.ceil(promptBound * rates.input + maxOutput * rates.output);
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	await ensureWallet(redis, day, scope);
	const keys = requestKeys(day, scope, kind);
	const admitted = await bounded(redis.eval(reserveScript, keys.length, ...keys, amount, kind === "reply-gate" ? gateLimit(config) : budgetLimit(config, scope), Math.floor((config.budget?.globalDailyYuan ?? 0) * units), ttl, personalLimit(config), keyBudget === "observe" ? "observe" : kind, Math.floor((config.budget?.replyGateGlobalDailyYuan ?? 0) * units)));
	if (Number(admitted) !== 1) throw new BudgetExceededError(await budgetFailureDetails(config, scope, kind, amount / units));
	init.signal?.throwIfAborted();
	assertAIEnabled(config);
	let response;
	try {
		init.onDispatch?.();
		response = await fetch(url, {
			...init,
			body: JSON.stringify(body)
		});
	} catch (error) {
		await markPendingBudget(redis, keys[2], "network-or-abort");
		throw error;
	}
	const applySettlement = async (counted) => {
		const result = await bounded(redis.eval(settleScript, keys.length, ...keys, usageCost(counted, rates), counted.prompt_tokens, counted.completion_tokens, counted.prompt_cache_hit_tokens || 0));
		if (Number(result) < 0) throw new DSHError("budget", "结算账本缺失，预占已保留，请联系主人核查。");
	};
	if (!response.ok) {
		if (response.status >= 500) await markPendingBudget(redis, keys[2], "upstream-error");
		if (response.status >= 400 && response.status < 500) try {
			await applySettlement({
				prompt_tokens: 0,
				completion_tokens: 0,
				prompt_cache_hit_tokens: 0
			});
		} catch (error) {
			logger.warn({
				status: response.status,
				error
			}, "Budget release after provider rejection failed");
		}
		return response;
	}
	if (!response.body) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const streaming = response.headers.get("content-type")?.includes("text/event-stream");
	let buffer = "", bytes = 0, usage, done = false;
	const frame = (raw) => {
		const data = raw.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
		if (data === "[DONE]") {
			done = true;
			return;
		}
		if (!data) return;
		const payload = JSON.parse(data);
		if (payload.error) throw new Error("Provider stream error");
		if (payload.usage) usage = parseUsage(payload.usage);
	};
	const settle = async () => {
		if (!usage || streaming && !done) {
			await markPendingBudget(redis, keys[2], "missing-usage-or-incomplete-stream");
			return;
		}
		const counted = textInput.hasImages ? {
			prompt_tokens: Math.min(usage.prompt_tokens, Math.ceil(textInput.bytes / 3)),
			completion_tokens: usage.completion_tokens,
			prompt_cache_hit_tokens: 0
		} : usage;
		await applySettlement(counted);
	};
	return new Response(new ReadableStream({
		async pull(controller) {
			try {
				const part = await reader.read();
				if (!part.done) bytes += part.value.byteLength;
				if (bytes > config.maxRequestBytes) throw new Error("模型响应超过大小限制。");
				buffer += decoder.decode(part.value, { stream: !part.done });
				if (streaming) {
					let boundary;
					while (boundary = /\r?\n\r?\n/u.exec(buffer)) {
						frame(buffer.slice(0, boundary.index));
						buffer = buffer.slice(boundary.index + boundary[0].length);
					}
					if (done) {
						await settle();
						if (!part.done) controller.enqueue(part.value);
						controller.close();
						await reader.cancel().catch(() => void 0);
						return;
					}
				}
				if (part.done) {
					if (!streaming) usage = parseUsage(JSON.parse(buffer)?.usage);
					await settle();
					controller.close();
				} else controller.enqueue(part.value);
			} catch (error) {
				await reader.cancel().catch(() => void 0);
				await markPendingBudget(redis, keys[2], "response-interrupted");
				controller.error(error);
			}
		},
		async cancel() {
			await markPendingBudget(redis, keys[2], "cancelled");
			await reader.cancel().catch(() => void 0);
		}
	}), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
};
const manageBudgetScript = `
local previous = redis.call('GET', KEYS[2])
if previous then
 if cjson.decode(previous).fingerprint ~= ARGV[7] then return 'conflict' end
 return previous
end
local field = ARGV[2] == 'add' and 'paidLimit' or 'limitOverride'
local before = tonumber(redis.call('HGET', KEYS[1], field) or (ARGV[2] == 'add' and '0' or ARGV[1]))
local amount = tonumber(ARGV[3])
local after = ARGV[2] == 'add' and before + amount or amount
local remaining = after - (ARGV[2] == 'add' and tonumber(redis.call('HGET', KEYS[1], 'paidUsed') or '0') or 0)
if after < 0 or after > 9007199254740991 or remaining > 10000000000 then return 'invalid' end
local entry = cjson.encode({ledger=field, fingerprint=ARGV[7], day=ARGV[6], at=tonumber(redis.call('TIME')[1]), actor=ARGV[4], operation=ARGV[2], amount=amount, before=before, after=after, used=tonumber(redis.call('HGET', KEYS[1], 'used') or '0')})
redis.call('HSET', KEYS[1], field, after)
if ARGV[2] ~= 'add' then redis.call('EXPIRE', KEYS[1], ARGV[5]) end
redis.call('SET', KEYS[2], entry, 'EX', ARGV[5])
redis.call('LPUSH', KEYS[3], entry)
redis.call('LTRIM', KEYS[3], 0, 999)
redis.call('EXPIRE', KEYS[3], ARGV[5])
return entry
`;
const manageBudget = async (config, scope, actor, operation, amount) => {
	if (!actor.isMaster) throw new DSHError("budget", "只有机器人主人可以管理额度。");
	if (!budgetEnabled(config)) throw new DSHError("budget", "每日额度保护未开启。");
	if (!scope.channelId || !scope.platform || scope.platform !== actor.platform || !actor.userId || !actor.channelId || !actor.messageId) throw new DSHError("budget", "缺少可靠的主人、平台或消息编号，无法安全修改额度。");
	if (!["add", "set"].includes(operation) || !Number.isSafeInteger(amount) || amount < 0 || amount > 1e4 * units || operation === "add" && amount === 0) throw new DSHError("budget", "金额无效：增加须大于 0，设置可为 0，最多 10000 元。");
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const [conversationKey] = keysFor(day, scope);
	const wallet = await ensureWallet(redis, day, scope);
	const key = operation === "add" ? wallet : scope.channelId.startsWith("private:") ? personalKey(day, privateUserScope(scope)) : gateKey(day, scope);
	const id = createHash("sha256").update(JSON.stringify([
		actor.platform,
		actor.channelId,
		actor.userId,
		actor.messageId
	])).digest("hex");
	const result = String(await bounded(redis.eval(manageBudgetScript, 3, key, `${prefix}:admin:${id}`, `${conversationKey}:adjustments`, budgetLimit(config, scope), operation, amount, actor.userId, ttl, day, JSON.stringify([
		scope.platform,
		scope.channelId,
		operation,
		amount
	]))));
	if (result === "conflict") throw new DSHError("budget", "这条消息已处理过其他额度调整，请发送新的指令。");
	if (result === "invalid") throw new DSHError("budget", "调整后的可用额度必须在 0–10000 元之间。");
	return JSON.parse(result);
};
const budgetAdjustments = async (scope, isMaster) => {
	if (!isMaster) throw new DSHError("budget", "只有机器人主人可以查看额度调整记录。");
	const redis = await budgetRedis();
	const [key] = keysFor(await redisDay(redis), scope);
	return (await bounded(redis.lrange(`${key}:adjustments`, 0, 4))).map((row) => JSON.parse(row));
};
const yuanLabel = (value) => value > 0 && value < .01 ? "<0.01" : Math.max(0, value).toFixed(2);
const budgetExceededMessage = insufficientBudgetHelp(false);
var BudgetExceededError = class extends DSHError {
	availableYuan;
	requiredYuan;
	constructor(details = {}) {
		const isPrivate = details.isPrivate ?? Boolean(getBudgetScope()?.channelId.startsWith("private:"));
		const [headline, ...rest] = insufficientBudgetHelp(isPrivate).split("\n\n");
		const hasAmounts = Number.isFinite(details.availableYuan) && Number.isFinite(details.requiredYuan);
		const amounts = hasAmounts ? `本次请求预计需要 ${yuanLabel(Number(details.requiredYuan))} 元，当前可用约 ${yuanLabel(Number(details.availableYuan))} 元。` : "";
		const reason = details.reason ?? (details.globalBlocked ? "global" : void 0);
		super("budget", [
			headline,
			amounts,
			reason === "global" ? "今日全局每日上限也已用满。" : reason === "personal" && !hasAmounts ? "个人可用额度已用满。" : "",
			...rest
		].filter(Boolean).join("\n\n"));
		this.name = "BudgetExceededError";
		this.availableYuan = details.availableYuan;
		this.requiredYuan = details.requiredYuan;
	}
};
/**
* A reservation was refused. Read the current ledger once so the user sees how
* far off the request was instead of a bare "额度不足". This only runs on the
* failure path; a healthy request never pays for the extra Redis round trip.
*/
async function budgetFailureDetails(config, scope, kind, requiredYuan) {
	const isPrivate = scope.channelId.startsWith("private:");
	try {
		const status = kind === "reply-gate" ? await replyGateBudgetStatus(config, scope) : await budgetStatus(config, scope);
		return {
			availableYuan: status.available,
			requiredYuan: Math.max(requiredYuan, status.blockedRequired),
			isPrivate,
			reason: status.reason,
			globalBlocked: status.reason === "global"
		};
	} catch {
		return {
			requiredYuan,
			isPrivate
		};
	}
}
const budgetNoticeScript = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 86400000)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
if redis.call('ZCOUNT', KEYS[1], '(' .. (now - 3600000), '+inf') >= 3 or
 redis.call('ZCOUNT', KEYS[1], '(' .. (now - 21600000), '+inf') >= 5 or
 redis.call('ZCARD', KEYS[1]) >= 7 then return 0 end
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('EXPIRE', KEYS[1], 86401)
return 1
`;
const claimBudgetNotice = async (scope, messageId) => {
	if (!scope.channelId || !scope.platform) return false;
	try {
		const redis = await budgetRedis();
		return Number(await bounded(redis.eval(budgetNoticeScript, 1, `${prefix}:notices:${scopeHash(scope)}`, messageId || randomUUID()))) === 1;
	} catch {
		return false;
	}
};
const replyGateExceededMessage = `本群今日感知预算不足，已暂停后台判断，今天只提醒这一次。\n@我、喊肥鱼或 /chat 仍可发问，聊天额度单独计算。\n\n${groupKeyGuide}\n\n也可请机器人主人为本群增加额度，或等北京时间零点重置。`;
const claimReplyGateBudgetNotice = async (scope) => {
	if (!scope.platform || !scope.channelId || scope.channelId.startsWith("private:")) return false;
	try {
		const redis = await budgetRedis();
		const day = await redisDay(redis);
		return await bounded(redis.set(`${prefix}:${day}:gate-notice:${scopeHash(scope)}`, "1", "EX", ttl, "NX")) === "OK";
	} catch {
		return false;
	}
};
const assertBudgetAvailable = async (config) => {
	assertAIEnabled(config);
	if (!budgetEnabled(config)) return;
	const scope = context.getStore();
	if (!scope?.platform || !scope.channelId || !scope.userId) throw new DSHError("budget", "无法确定本次调用所属会话或用户。");
	const { checkedBoundCredential } = await import("../credentials/scoped.js");
	if (await checkedBoundCredential()) return;
	const status = await budgetStatus(config, scope);
	if (status.blocked) throw new BudgetExceededError({
		availableYuan: status.available,
		requiredYuan: status.blockedRequired > 0 ? status.blockedRequired : void 0,
		reason: status.reason
	});
};
const reserveWorkspaceText = async (config, input) => {
	assertAIEnabled(config);
	if (!budgetEnabled(config)) return async () => {};
	const scope = context.getStore();
	if (!scope?.platform || !scope.channelId) throw new DSHError("budget", "无法确定工作区调用所属会话。");
	const { getDSHCredentials } = await import("../dsh/credentials.js");
	const credentials = await getDSHCredentials();
	const base = credentials?.baseUrl || (config.provider === "deepseek-official" ? "https://api.deepseek.com" : "");
	const rates = credentials?.pricing || officialRates(new URL(`${base.replace(/\/+$/u, "")}/chat/completions`), credentials?.model || config.model);
	const promptTokens = Math.ceil(Buffer.byteLength(input) / 3);
	const amount = usageCost({
		prompt_tokens: promptTokens,
		completion_tokens: config.budget?.maxOutputTokens ?? 2048
	}, rates);
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	await ensureWallet(redis, day, scope);
	const keys = requestKeys(day, scope);
	if (Number(await bounded(redis.eval("\nlocal gate = ARGV[6] == 'reply-gate'\nlocal autonomous = ARGV[6] == 'autonomous'\nlocal observe = ARGV[6] == 'observe'\nlocal maximum=9007199254740991\nlocal function integer(value)\n local n=tonumber(value)\n return n and n>=0 and n<=maximum and n==math.floor(n)\nend\nlocal function invalid() return redis.error_reply('Invalid budget reservation ledger') end\n-- Validate reads, types and expiry before even changing blocked notices.\nfor _,i in ipairs({1,2,3,4,5,7}) do\n if not integer(ARGV[i] or (i==7 and '0' or '')) then return invalid() end\nend\nif tonumber(ARGV[4])<1 then return invalid() end\nfor i,key in ipairs(KEYS) do\n if i~=3 then\n  if key==KEYS[3] then return invalid() end\n  local kind=redis.call('TYPE',key).ok\n  if kind~='none' and kind~='hash' then return invalid() end\n  for _,field in ipairs({'used','reserved','requests','pendingRequests','paidUsed','paidReserved','paidLimit','limitOverride'}) do\n   local value=redis.call('HGET',key,field)\n   if value and (not string.match(value,'^%d+$') or not integer(value) or string.format('%.0f',tonumber(value))~=value) then return invalid() end\n  end\n end\nend\nif redis.call('EXISTS',KEYS[3])==1 then return 0 end\nlocal amount = tonumber(ARGV[1])\nlocal used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')\nlocal wallet = KEYS[6] or KEYS[1]\nlocal paidUsed = tonumber(redis.call('HGET', wallet, 'paidUsed') or '0')\nlocal paidLimit = tonumber(redis.call('HGET', wallet, 'paidLimit') or '0')\nlocal paid = math.min(amount, math.max(0, paidLimit - paidUsed))\nlocal free = amount - paid\nlocal total = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')\nlocal gateTotal = gate and KEYS[5] and tonumber(redis.call('HGET', KEYS[5], 'used') or '0') or 0\nlocal gateGlobalBlocked = gate and tonumber(ARGV[7] or '0') > 0 and gateTotal + amount > tonumber(ARGV[7])\nlocal person = tonumber(redis.call('HGET', KEYS[4], 'used') or '0')\nlocal limit = tonumber(redis.call('HGET', KEYS[4], 'limitOverride') or (gate and ARGV[2] or ARGV[5]))\nlocal freeUsed = gate and person - tonumber(redis.call('HGET', KEYS[4], 'paidUsed') or '0') or person\nlocal groupBlocked = gate and free > 0 and freeUsed + free > limit\nlocal personBlocked = not gate and free > 0 and (autonomous or person + free > limit)\n-- Aggregate aliases too: one hash can serve multiple ledger roles.\nlocal changes={}\nlocal function add(key,field,delta)\n changes[key]=changes[key] or {}\n changes[key][field]=(changes[key][field] or 0)+delta\nend\nfor _,i in ipairs({1,2,4}) do\n local debit=gate and (i==1 and paid or amount) or (i==4 and free or amount)\n add(KEYS[i],'used',debit)\n add(KEYS[i],'reserved',debit)\n add(KEYS[i],'requests',1)\n add(KEYS[i],'pendingRequests',1)\nend\nif gate and KEYS[5] then\n add(KEYS[5],'used',amount)\n add(KEYS[5],'reserved',amount)\n add(KEYS[5],'pendingRequests',1)\nend\nadd(wallet,'paidUsed',paid)\nadd(wallet,'paidReserved',paid)\nif gate then add(KEYS[4],'paidUsed',paid) end\nfor key,fields in pairs(changes) do\n for field,delta in pairs(fields) do\n  local before=tonumber(redis.call('HGET',key,field) or '0')\n  if not integer(delta) or delta>maximum-before then return invalid() end\n end\nend\nif not observe and (groupBlocked or personBlocked or gateGlobalBlocked or (tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3]))) then\n if groupBlocked then redis.call('HSET', KEYS[4], 'blockedRequired', free) end\n if personBlocked then redis.call('HSET', KEYS[4], 'blockedRequired', free) end\n if tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3]) then redis.call('HSET', KEYS[2], 'blockedRequired', amount) end\n if gateGlobalBlocked then redis.call('HSET', KEYS[5], 'blockedRequired', amount) if (tonumber(redis.call('HGET',KEYS[5],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[5],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[5]) else redis.call('EXPIRE', KEYS[5], ARGV[4]) end end\n for _,i in ipairs({1,2,4}) do if (tonumber(redis.call('HGET',KEYS[i],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[i],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[i]) else redis.call('EXPIRE', KEYS[i], ARGV[4]) end end\n return 0\nend\nif redis.call('EXISTS', KEYS[3]) == 1 then return 0 end\nif free > 0 then redis.call('HDEL', KEYS[4], 'blockedRequired') end\nredis.call('HDEL', KEYS[2], 'blockedRequired')\nif gate and KEYS[5] then\n redis.call('HDEL', KEYS[5], 'blockedRequired')\n redis.call('HINCRBY', KEYS[5], 'used', string.format('%.0f',amount))\n redis.call('HINCRBY', KEYS[5], 'reserved', string.format('%.0f',amount))\n redis.call('HINCRBY', KEYS[5], 'pendingRequests', 1)\n if (tonumber(redis.call('HGET',KEYS[5],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[5],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[5]) else redis.call('EXPIRE', KEYS[5], ARGV[4]) end\nend\nredis.call('SET', KEYS[3], cjson.encode({amount=amount,paid=paid,gate=gate,keys=KEYS,retentionVersion=1,at=tonumber(redis.call('TIME')[1])}))\nfor _,i in ipairs({1,2,4}) do\n local debit = gate and (i == 1 and paid or amount) or (i == 4 and free or amount)\n redis.call('HINCRBY', KEYS[i], 'used', string.format('%.0f',debit))\n redis.call('HINCRBY', KEYS[i], 'reserved', string.format('%.0f',debit))\n redis.call('HINCRBY', KEYS[i], 'requests', 1)\n redis.call('HINCRBY', KEYS[i], 'pendingRequests', 1)\n if (tonumber(redis.call('HGET',KEYS[i],'reserved') or '0')>0 or tonumber(redis.call('HGET',KEYS[i],'pendingRequests') or '0')>0) then redis.call('PERSIST',KEYS[i]) else redis.call('EXPIRE', KEYS[i], ARGV[4]) end\nend\nredis.call('HINCRBY', KEYS[6] or KEYS[1], 'paidUsed', string.format('%.0f',paid))\nredis.call('HINCRBY', KEYS[6] or KEYS[1], 'paidReserved', string.format('%.0f',paid))\nif gate then redis.call('HINCRBY', KEYS[4], 'paidUsed', string.format('%.0f',paid)) end\nreturn 1\n", keys.length, ...keys, amount, budgetLimit(config, scope), Math.floor((config.budget?.globalDailyYuan ?? 0) * units), ttl, personalLimit(config), scope.autonomous ? "autonomous" : "chat"))) !== 1) throw new BudgetExceededError(await budgetFailureDetails(config, scope, scope.autonomous ? "autonomous" : "chat", amount / units));
	return async (output) => {
		const usage = {
			prompt_tokens: promptTokens,
			completion_tokens: Math.ceil(Buffer.byteLength(output) / 3)
		};
		const result = await bounded(redis.eval(settleScript, keys.length, ...keys, usageCost(usage, rates), usage.prompt_tokens, usage.completion_tokens, 0));
		if (Number(result) < 0) throw new DSHError("budget", "结算账本缺失，请联系主人核查。");
	};
};
/** Explicit deployment operation: fixed-date, idempotent, no inference from past days. */
const migrateLegacyWallets = async (date) => {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || (/* @__PURE__ */ new Date(`${date}T00:00:00Z`)).toISOString().slice(0, 10) !== date) throw new DSHError("budget", "请提供迁移基准日期 YYYY-MM-DD。");
	const redis = await budgetRedis();
	if (date > await redisDay(redis)) throw new DSHError("budget", "迁移日期不能晚于当前北京时间日期。");
	await redis.set(`${prefix}:wallet-migration-day`, date, "NX");
	const pinned = await redis.get(`${prefix}:wallet-migration-day`);
	if (pinned !== date) throw new DSHError("budget", `迁移日期已固定为 ${pinned}，不能自动改写。`);
	const keyPrefix = redis.options?.keyPrefix || "";
	let cursor = "0";
	const report = [];
	do {
		const page = await redis.scan(cursor, "MATCH", `${keyPrefix}${prefix}:${date}:*`, "COUNT", 100);
		cursor = page[0];
		for (const full of page[1]) {
			const key = full.slice(keyPrefix.length);
			const hash = key.slice(`${prefix}:${date}:`.length);
			if (!/^[a-f0-9]{64}$/u.test(hash)) continue;
			const target = `${prefix}:wallet:${hash}`;
			const result = Number(await redis.eval(walletMigrationScript, 2, target, key));
			const value = await redis.hgetall(result === 1 ? target : key);
			report.push({
				wallet: hash,
				result: result === 1 ? "migrated" : "pending",
				remaining: Math.max(0, Number(value.paidLimit || 0) - Number(value.paidUsed || 0)) / units
			});
		}
	} while (cursor !== "0");
	await redis.set(`${prefix}:wallet-migration-report`, JSON.stringify({
		date,
		at: Date.now(),
		report
	}));
	return {
		date,
		report
	};
};
/** Server-side maintenance only. Never expose receipts or Redis keys in group messages. */
const pendingBudgetRequests = async () => {
	const redis = await budgetRedis();
	const keyPrefix = redis.options?.keyPrefix || "";
	let cursor = "0";
	const rows = [];
	const now = Number((await redis.time())[0]);
	do {
		const page = await redis.scan(cursor, "MATCH", `${keyPrefix}${prefix}:*:request:*`, "COUNT", 100);
		cursor = page[0];
		for (const full of page[1]) {
			const key = full.slice(keyPrefix.length);
			if (!/request:[a-f0-9-]{36}$/u.test(key)) continue;
			const raw = await redis.get(key);
			if (!raw) continue;
			const value = JSON.parse(raw);
			rows.push({
				id: key.slice(28),
				amount: Number(value.amount) / units,
				ageSeconds: value.at ? now - value.at : -1,
				reason: value.reason || "unsettled",
				recoverable: Array.isArray(value.keys)
			});
		}
	} while (cursor !== "0");
	return rows;
};
const reconcileBudgetRequest = async (id, actual, operator) => {
	if (!/^\d{4}-\d{2}-\d{2}:request:[a-f0-9-]{36}$/u.test(id) || !/^\d+(?:\.\d{1,6})?$/u.test(actual) || !operator.trim()) throw new DSHError("budget", "核对参数无效。");
	const redis = await budgetRedis();
	const key = `${prefix}:${id}`;
	const raw = await redis.get(key);
	if (!raw) return false;
	const receipt = JSON.parse(raw);
	const keyPrefix = redis.options?.keyPrefix || "";
	const receiptKeys = Array.isArray(receipt.keys) ? receipt.keys.map((value) => typeof value === "string" && value.startsWith(keyPrefix + "data:{agent-link-budget}:v1:") ? value.slice(keyPrefix.length) : null) : [];
	const amount = Math.round(Number(actual) * units);
	if (!Number.isSafeInteger(amount) || amount > receipt.amount || !Array.isArray(receipt.keys) || receiptKeys.length < 4 || receiptKeys.length > 6 || receiptKeys.some((value) => value === null) || receiptKeys[2] !== key || !receipt.at || Number((await redis.time())[0]) - receipt.at < 3600) throw new DSHError("budget", "只能核对一小时前、有完整账本信息且实际费用不超过预占的请求。旧版记录需单独人工核查。");
	const result = Number(await redis.eval(settleScript, receiptKeys.length, ...receiptKeys, amount, 0, 0, 0, operator));
	if (result < 0) throw new DSHError("budget", "结算账本缺失，未修改预占，请先核查数据。");
	return result === 1;
};
/** Preserve existing unresolved evidence during upgrade, without changing balances. */
const retainPendingBudgetRequests = async () => {
	const redis = await budgetRedis();
	const keyPrefix = redis.options?.keyPrefix || "";
	const rows = await pendingBudgetRequests();
	let retained = 0;
	let legacyWithoutLedgers = 0;
	for (const row of rows) {
		const key = `${prefix}:${row.id}`;
		const raw = await redis.get(key);
		if (!raw) continue;
		const value = JSON.parse(raw);
		const ledgers = Array.isArray(value.keys) ? value.keys.filter((item) => typeof item === "string" && item.startsWith(keyPrefix + "data:{agent-link-budget}:v1:")).map((item) => item.slice(keyPrefix.length)) : [];
		const valid = ledgers.length === value.keys?.length && ledgers[2] === key && ledgers.length >= 4 && ledgers.length <= 6;
		const keys = valid ? ledgers : [key];
		const result = Number(await redis.eval(valid ? `
if redis.call('GET',KEYS[3]) ~= ARGV[1] then return 0 end
local receipt=cjson.decode(ARGV[1])
if receipt.retentionVersion~=1 then
 local counts={}
 for _,i in ipairs({1,2,4}) do counts[KEYS[i]]=(counts[KEYS[i]] or 0)+1 end
 if receipt.gate and KEYS[5] then counts[KEYS[5]]=(counts[KEYS[5]] or 0)+1 end
 -- A missing ledger cannot be reconstructed safely from a receipt.
 for i,key in ipairs(KEYS) do
  if i~=3 and (key==KEYS[3] or ((counts[key] or i==6) and redis.call('TYPE',key).ok~='hash')) then return redis.error_reply('Missing retention ledger') end
 end
 for key,delta in pairs(counts) do
  local value=redis.call('HGET',key,'pendingRequests') or '0'
  local n=tonumber(value)
  if not string.match(value,'^%d+$') or not n or n>9007199254740991-delta or string.format('%.0f',n)~=value then return redis.error_reply('Invalid retention counter') end
 end
 for key,delta in pairs(counts) do redis.call('HINCRBY',key,'pendingRequests',delta) end
 receipt.retentionVersion=1
 redis.call('SET',KEYS[3],cjson.encode(receipt))
end
for _,key in ipairs(KEYS) do redis.call('PERSIST',key) end
return 1` : `
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PERSIST',KEYS[1])
return 1`, keys.length, ...keys, raw));
		retained += result;
		if (result && !valid) legacyWithoutLedgers++;
	}
	return {
		retained,
		legacyWithoutLedgers
	};
};

export { BudgetExceededError, assertBudgetAvailable, budgetAdjustments, budgetBlockReason, budgetDay, budgetEnabled, budgetExceededMessage, budgetLimit, budgetNoticeScript, budgetRedis, budgetStatus, budgetedFetch, claimBudgetNotice, claimReplyGateBudgetNotice, getBudgetScope, groupKeyBudgetStatus, groupKeyDailyLimit, groupKeyLimitDetails, manageBudget, manageBudgetScript, migrateLegacyWallets, officialRates, parseUsage, pendingBudgetRequests, reconcileBudgetRequest, replyGateBudgetStatus, replyGateExceededMessage, reserveScript, reserveWorkspaceText, retainPendingBudgetRequests, setGroupKeyDailyLimit, settleScript, textBudgetInput, usageCost, walletMigrationScript, withBudgetScope };