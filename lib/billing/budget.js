import { DSHError } from "../dsh/errors.js";
import { assertAIEnabled } from "../dsh/ai-switch.js";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// src/billing/budget.ts
const context = new AsyncLocalStorage();
const getBudgetScope = () => context.getStore();
const withBudgetScope = (scope, run) => context.run(scope, run);
const budgetEnabled = (config) => config.budget?.enabled === true;
const prefix = "data:{agent-link-budget}:v1";
const ttl = 2764800;
const units = 1e6;
const budgetDay = (ms) => new Date(ms + 288e5).toISOString().slice(0, 10);
const budgetLimit = (config, scope) => Math.floor((scope.channelId.startsWith("private:") ? config.budget?.privateDailyYuan ?? 1 : config.budget?.groupDailyYuan ?? 2) * units);
const scopeHash = (scope) => createHash("sha256").update(JSON.stringify([scope.platform, scope.channelId])).digest("hex");
const reserveScript = `
local gate = ARGV[6] == 'reply-gate'
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
local paidUsed = tonumber(redis.call('HGET', KEYS[1], 'paidUsed') or '0')
local paidLimit = tonumber(redis.call('HGET', KEYS[1], 'paidLimit') or '0')
local paid = math.min(amount, math.max(0, paidLimit - paidUsed))
local free = amount - paid
local total = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')
local person = tonumber(redis.call('HGET', KEYS[4], 'used') or '0')
local limit = tonumber(redis.call('HGET', KEYS[1], 'limitOverride') or ARGV[2])
local freeUsed = gate and person - tonumber(redis.call('HGET', KEYS[4], 'paidUsed') or '0') or used - paidUsed
if gate then limit = tonumber(ARGV[2]) end
local groupBlocked = free > 0 and freeUsed + free > limit
local personBlocked = not gate and free > 0 and person + free > tonumber(ARGV[5])
if groupBlocked or personBlocked or (tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3])) then
 if groupBlocked then redis.call('HSET', gate and KEYS[4] or KEYS[1], 'blockedRequired', amount) end
 if personBlocked then redis.call('HSET', KEYS[4], 'blockedRequired', free) end
 if tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3]) then redis.call('HSET', KEYS[2], 'blockedRequired', amount) end
 for _,i in ipairs({1,2,4}) do redis.call('EXPIRE', KEYS[i], ARGV[4]) end
 return 0
end
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('HDEL', gate and KEYS[4] or KEYS[1], 'blockedRequired')
redis.call('HDEL', KEYS[2], 'blockedRequired')
redis.call('SET', KEYS[3], cjson.encode({amount=amount,paid=paid,gate=gate}), 'EX', ARGV[4])
for _,i in ipairs({1,2,4}) do
 local debit = gate and (i == 1 and paid or amount) or (i == 4 and free or amount)
 redis.call('HINCRBY', KEYS[i], 'used', debit)
 redis.call('HINCRBY', KEYS[i], 'reserved', debit)
 redis.call('HINCRBY', KEYS[i], 'requests', 1)
 redis.call('EXPIRE', KEYS[i], ARGV[4])
end
redis.call('HINCRBY', KEYS[1], 'paidUsed', paid)
redis.call('HINCRBY', KEYS[1], 'paidReserved', paid)
if gate then redis.call('HINCRBY', KEYS[4], 'paidUsed', paid) end
return 1
`;
const settleScript = `
local raw = redis.call('GET', KEYS[3])
if not raw then return 0 end
local reservation = cjson.decode(raw)
local reserved = reservation.amount
-- Settlement uses exactly the funding sources reserved for this request.
-- Refund unused recharge first only after actual spend consumes its allocation.
local actual = tonumber(ARGV[1])
local paid = math.min(actual, reservation.paid)
for _,i in ipairs({1,2,4}) do
 local before = reservation.gate and (i == 1 and reservation.paid or reserved) or (i == 4 and reserved - reservation.paid or reserved)
 local after = reservation.gate and (i == 1 and paid or actual) or (i == 4 and actual - paid or actual)
 redis.call('HINCRBY', KEYS[i], 'used', after - before)
 redis.call('HINCRBY', KEYS[i], 'reserved', -before)
 redis.call('HINCRBY', KEYS[i], 'promptTokens', ARGV[2])
 redis.call('HINCRBY', KEYS[i], 'completionTokens', ARGV[3])
 redis.call('HINCRBY', KEYS[i], 'cacheHitTokens', ARGV[4])
 redis.call('HINCRBY', KEYS[i], 'settled', 1)
end
redis.call('HINCRBY', KEYS[1], 'paidUsed', paid - reservation.paid)
redis.call('HINCRBY', KEYS[1], 'paidReserved', -reservation.paid)
if reservation.gate then redis.call('HINCRBY', KEYS[4], 'paidUsed', paid - reservation.paid) end
redis.call('DEL', KEYS[3])
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
const personalLimit = (config) => Math.floor((config.budget?.personalDailyYuan ?? 1) * units);
const personalKey = (day, scope) => {
	if (!scope.userId) throw new DSHError("budget", "无法确定本次调用所属用户，已暂停付费调用。");
	return `${prefix}:${day}:person:${scopeHash({
		platform: scope.platform,
		channelId: scope.userId
	})}`;
};
const gateLimit = (config) => Math.floor((config.budget?.replyGateDailyYuan ?? 1) * units);
const gateKey = (day, scope) => `${prefix}:${day}:gate:${scopeHash(scope)}`;
const requestKeys = (day, scope, kind = "chat") => [
	...keysFor(day, scope),
	`${prefix}:${day}:request:${randomUUID()}`,
	kind === "reply-gate" ? gateKey(day, scope) : personalKey(day, scope)
];
const budgetStatus = async (config, scope) => {
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const [key, totalKey] = keysFor(day, scope);
	const [value, total, person] = await bounded(Promise.all([
		redis.hgetall(key),
		redis.hgetall(totalKey),
		scope.userId ? redis.hgetall(personalKey(day, scope)) : Promise.resolve({})
	]));
	const freeLimit = value.limitOverride === void 0 ? budgetLimit(config, scope) : Number(value.limitOverride);
	const used = Number(value.used || 0);
	const paidUsed = Number(value.paidUsed || 0);
	const paidLimit = Number(value.paidLimit || 0);
	const paidRemaining = Math.max(0, paidLimit - paidUsed);
	const freeUsed = used - paidUsed;
	const freeRemaining = Math.max(0, freeLimit - freeUsed);
	const personUsed = Number(person.used || 0);
	const personRemaining = Math.max(0, personalLimit(config) - personUsed);
	const required = Number(value.blockedRequired || 0);
	const personRequired = Number(person.blockedRequired || 0);
	const globalUsed = Number(total.used || 0);
	const globalLimit = Math.floor((config.budget?.globalDailyYuan ?? 0) * units);
	const available = paidRemaining + Math.min(freeRemaining, scope.userId ? personRemaining : freeRemaining);
	return {
		day,
		blocked: available <= 0 || available < required || Boolean(scope.userId) && personRemaining + paidRemaining < personRequired || globalLimit > 0 && (globalUsed >= globalLimit || globalUsed + Number(total.blockedRequired || 0) > globalLimit),
		limit: (freeLimit + paidLimit) / units,
		defaultLimit: budgetLimit(config, scope) / units,
		freeLimit: freeLimit / units,
		freeUsed: freeUsed / units,
		freeRemaining: freeRemaining / units,
		paidLimit: paidLimit / units,
		paidUsed: paidUsed / units,
		paidRemaining: paidRemaining / units,
		personalLimit: personalLimit(config) / units,
		personalUsed: personUsed / units,
		personalRemaining: personRemaining / units,
		personalReserved: Number(person.reserved || 0) / units,
		used: used / units,
		remaining: (freeRemaining + paidRemaining) / units,
		available: available / units,
		reserved: Number(value.reserved || 0) / units,
		requests: Number(value.requests || 0),
		promptTokens: Number(value.promptTokens || 0),
		completionTokens: Number(value.completionTokens || 0),
		cacheHitTokens: Number(value.cacheHitTokens || 0),
		globalUsed: globalUsed / units
	};
};
const replyGateBudgetStatus = async (config, scope) => {
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const [groupKey, totalKey] = keysFor(day, scope);
	const [gate, group, total] = await bounded(Promise.all([
		redis.hgetall(gateKey(day, scope)),
		redis.hgetall(groupKey),
		redis.hgetall(totalKey)
	]));
	const used = Number(gate.used || 0);
	const paidUsed = Number(gate.paidUsed || 0);
	const freeRemaining = Math.max(0, gateLimit(config) - (used - paidUsed));
	const available = freeRemaining + Math.max(0, Number(group.paidLimit || 0) - Number(group.paidUsed || 0));
	const globalLimit = Math.floor((config.budget?.globalDailyYuan ?? 0) * units);
	return {
		limit: gateLimit(config) / units,
		used: used / units,
		freeUsed: (used - paidUsed) / units,
		freeRemaining: freeRemaining / units,
		paidUsed: paidUsed / units,
		reserved: Number(gate.reserved || 0) / units,
		blocked: available <= 0 || available < Number(gate.blockedRequired || 0) || globalLimit > 0 && (Number(total.used || 0) >= globalLimit || Number(total.used || 0) + Number(total.blockedRequired || 0) > globalLimit)
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
const budgetedFetch = async (config, url, init, kind = "chat") => {
	assertAIEnabled(config);
	if (kind === "reply-gate" && getBudgetScope()?.channelId.startsWith("private:")) throw new DSHError("budget", "主动搭话识别仅限群会话。");
	if (init.personalKey && !getBudgetScope()?.channelId.startsWith("private:")) throw new DSHError("budget", "个人 Key 只能用于本人私聊。");
	const { getBoundCredential, checkedBoundCredential, disableBoundCredential } = await import("../credentials/scoped.js");
	if (init.personalKey || init.scopedKey || await getBoundCredential()) {
		const personal = await checkedBoundCredential(init.signal || void 0);
		if (personal) {
			const headers = new Headers(init.headers);
			headers.set("Authorization", `Bearer ${personal.apiKey}`);
			const result = await fetch(new URL("https://api.deepseek.com/chat/completions"), {
				...init,
				headers,
				redirect: "error"
			});
			if (result.status !== 402) return result;
			await result.body?.cancel();
			if (!await disableBoundCredential(personal)) throw new DSHError("budget", "绑定 Key 设置已变更，请重新发送请求。");
		}
		const { getDSHCredentials } = await import("../dsh/credentials.js");
		const shared = await getDSHCredentials();
		if (!shared) throw new DSHError("budget", "绑定 Key 已停用，但机器人未配置模型凭证。");
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${shared.apiKey}`);
		init = {
			...init,
			headers
		};
		url = new URL(`${(shared.baseUrl || "https://api.deepseek.com").replace(/\/+$/u, "")}/chat/completions`);
	}
	if (!budgetEnabled(config)) return fetch(url, init);
	init.signal?.throwIfAborted();
	const scope = context.getStore();
	if (!scope?.channelId || !scope.platform) throw new DSHError("budget", "无法确定本次调用所属会话，已暂停付费调用。");
	if (kind === "reply-gate" && scope.channelId.startsWith("private:")) throw new DSHError("budget", "主动搭话识别仅限群会话。");
	const body = JSON.parse(String(init.body));
	const rates = officialRates(url, body.model);
	const textInput = textBudgetInput(body);
	const maxOutput = Math.min(config.budget?.maxOutputTokens ?? 2048, Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : config.budget?.maxOutputTokens ?? 2048);
	body.max_tokens = maxOutput;
	if (body.stream) body.stream_options = { include_usage: true };
	const promptBound = textInput.bytes + 8192;
	const amount = Math.ceil(promptBound * rates.input + maxOutput * rates.output);
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const keys = requestKeys(day, scope, kind);
	const admitted = await bounded(redis.eval(reserveScript, 4, ...keys, amount, kind === "reply-gate" ? gateLimit(config) : budgetLimit(config, scope), Math.floor((config.budget?.globalDailyYuan ?? 0) * units), ttl, personalLimit(config), kind));
	if (Number(admitted) !== 1) throw new BudgetExceededError();
	init.signal?.throwIfAborted();
	assertAIEnabled(config);
	const response = await fetch(url, {
		...init,
		body: JSON.stringify(body)
	});
	if (!response.ok || !response.body) return response;
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
		if (!usage || streaming && !done) return;
		const counted = textInput.hasImages ? {
			prompt_tokens: Math.min(usage.prompt_tokens, Math.ceil(textInput.bytes / 3)),
			completion_tokens: usage.completion_tokens,
			prompt_cache_hit_tokens: 0
		} : usage;
		await bounded(redis.eval(settleScript, 4, ...keys, usageCost(counted, rates), counted.prompt_tokens, counted.completion_tokens, counted.prompt_cache_hit_tokens || 0));
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
				controller.error(error);
			}
		},
		async cancel() {
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
if after < 0 or after > 10000000000 then return 'invalid' end
local entry = cjson.encode({ledger=field, fingerprint=ARGV[7], day=ARGV[6], at=tonumber(redis.call('TIME')[1]), actor=ARGV[4], operation=ARGV[2], amount=amount, before=before, after=after, used=tonumber(redis.call('HGET', KEYS[1], 'used') or '0')})
redis.call('HSET', KEYS[1], field, after)
redis.call('EXPIRE', KEYS[1], ARGV[5])
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
	const [key] = keysFor(day, scope);
	const id = createHash("sha256").update(JSON.stringify([
		actor.platform,
		actor.channelId,
		actor.userId,
		actor.messageId
	])).digest("hex");
	const result = String(await bounded(redis.eval(manageBudgetScript, 3, key, `${prefix}:admin:${id}`, `${key}:adjustments`, budgetLimit(config, scope), operation, amount, actor.userId, ttl, day, JSON.stringify([
		scope.platform,
		scope.channelId,
		operation,
		amount
	]))));
	if (result === "conflict") throw new DSHError("budget", "这条消息已处理过其他额度调整，请发送新的指令。");
	if (result === "invalid") throw new DSHError("budget", "调整后的当日额度必须在 0–10000 元之间。");
	return JSON.parse(result);
};
const budgetAdjustments = async (scope, isMaster) => {
	if (!isMaster) throw new DSHError("budget", "只有机器人主人可以查看额度调整记录。");
	const redis = await budgetRedis();
	const [key] = keysFor(await redisDay(redis), scope);
	return (await bounded(redis.lrange(`${key}:adjustments`, 0, 4))).map((row) => JSON.parse(row));
};
const budgetExceededMessage = "今日可用额度不足。/额度 查看余额，可联系主人调整或等北京时间零点重置。";
var BudgetExceededError = class extends DSHError {
	constructor() {
		super("budget", budgetExceededMessage);
	}
};
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
const replyGateExceededMessage = "本群今日回复判断额度已用完，已暂停自动判断；聊天额度单独计算。/额度 查看余额，可联系主人调整或等北京时间零点重置。";
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
	if ((await budgetStatus(config, scope)).blocked) throw new BudgetExceededError();
};
const reserveWorkspaceText = async (config, input) => {
	assertAIEnabled(config);
	if (!budgetEnabled(config)) return async () => {};
	const scope = context.getStore();
	if (!scope?.platform || !scope.channelId) throw new DSHError("budget", "无法确定工作区调用所属会话。");
	const { getDSHCredentials } = await import("../dsh/credentials.js");
	const base = (await getDSHCredentials())?.baseUrl || (config.provider === "deepseek-official" ? "https://api.deepseek.com" : "");
	const rates = officialRates(new URL(`${base.replace(/\/+$/u, "")}/chat/completions`), config.model);
	const promptTokens = Math.ceil(Buffer.byteLength(input) / 3);
	const amount = usageCost({
		prompt_tokens: promptTokens,
		completion_tokens: config.budget?.maxOutputTokens ?? 2048
	}, rates);
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const keys = requestKeys(day, scope);
	if (Number(await bounded(redis.eval("\nlocal gate = ARGV[6] == 'reply-gate'\nlocal amount = tonumber(ARGV[1])\nlocal used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')\nlocal paidUsed = tonumber(redis.call('HGET', KEYS[1], 'paidUsed') or '0')\nlocal paidLimit = tonumber(redis.call('HGET', KEYS[1], 'paidLimit') or '0')\nlocal paid = math.min(amount, math.max(0, paidLimit - paidUsed))\nlocal free = amount - paid\nlocal total = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')\nlocal person = tonumber(redis.call('HGET', KEYS[4], 'used') or '0')\nlocal limit = tonumber(redis.call('HGET', KEYS[1], 'limitOverride') or ARGV[2])\nlocal freeUsed = gate and person - tonumber(redis.call('HGET', KEYS[4], 'paidUsed') or '0') or used - paidUsed\nif gate then limit = tonumber(ARGV[2]) end\nlocal groupBlocked = free > 0 and freeUsed + free > limit\nlocal personBlocked = not gate and free > 0 and person + free > tonumber(ARGV[5])\nif groupBlocked or personBlocked or (tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3])) then\n if groupBlocked then redis.call('HSET', gate and KEYS[4] or KEYS[1], 'blockedRequired', amount) end\n if personBlocked then redis.call('HSET', KEYS[4], 'blockedRequired', free) end\n if tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3]) then redis.call('HSET', KEYS[2], 'blockedRequired', amount) end\n for _,i in ipairs({1,2,4}) do redis.call('EXPIRE', KEYS[i], ARGV[4]) end\n return 0\nend\nif redis.call('EXISTS', KEYS[3]) == 1 then return 0 end\nredis.call('HDEL', gate and KEYS[4] or KEYS[1], 'blockedRequired')\nredis.call('HDEL', KEYS[2], 'blockedRequired')\nredis.call('SET', KEYS[3], cjson.encode({amount=amount,paid=paid,gate=gate}), 'EX', ARGV[4])\nfor _,i in ipairs({1,2,4}) do\n local debit = gate and (i == 1 and paid or amount) or (i == 4 and free or amount)\n redis.call('HINCRBY', KEYS[i], 'used', debit)\n redis.call('HINCRBY', KEYS[i], 'reserved', debit)\n redis.call('HINCRBY', KEYS[i], 'requests', 1)\n redis.call('EXPIRE', KEYS[i], ARGV[4])\nend\nredis.call('HINCRBY', KEYS[1], 'paidUsed', paid)\nredis.call('HINCRBY', KEYS[1], 'paidReserved', paid)\nif gate then redis.call('HINCRBY', KEYS[4], 'paidUsed', paid) end\nreturn 1\n", 4, ...keys, amount, budgetLimit(config, scope), Math.floor((config.budget?.globalDailyYuan ?? 0) * units), ttl, personalLimit(config)))) !== 1) throw new BudgetExceededError();
	return async (output) => {
		const usage = {
			prompt_tokens: promptTokens,
			completion_tokens: Math.ceil(Buffer.byteLength(output) / 3)
		};
		await bounded(redis.eval(settleScript, 4, ...keys, usageCost(usage, rates), usage.prompt_tokens, usage.completion_tokens, 0));
	};
};

export { BudgetExceededError, assertBudgetAvailable, budgetAdjustments, budgetDay, budgetEnabled, budgetExceededMessage, budgetLimit, budgetNoticeScript, budgetRedis, budgetStatus, budgetedFetch, claimBudgetNotice, claimReplyGateBudgetNotice, getBudgetScope, manageBudget, manageBudgetScript, officialRates, parseUsage, replyGateBudgetStatus, replyGateExceededMessage, reserveScript, reserveWorkspaceText, settleScript, textBudgetInput, usageCost, withBudgetScope };