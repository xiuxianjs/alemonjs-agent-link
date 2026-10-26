import { DSHError } from "../dsh/errors.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

// src/billing/budget.ts
const context = new AsyncLocalStorage();
const withBudgetScope = (scope, run) => context.run(scope, run);
const budgetEnabled = (config) => config.budget?.enabled === true;
const prefix = "data:{agent-link-budget}:v1";
const ttl = 2764800;
const units = 1e6;
const budgetDay = (ms) => new Date(ms + 288e5).toISOString().slice(0, 10);
const budgetLimit = (config, scope) => Math.floor((scope.channelId.startsWith("private:") ? config.budget?.privateDailyYuan ?? 1 : config.budget?.groupDailyYuan ?? 2) * units);
const scopeHash = (scope) => createHash("sha256").update(JSON.stringify([scope.platform, scope.channelId])).digest("hex");
const reserveScript = `
local amount = tonumber(ARGV[1])
local used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')
local total = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')
local limit = tonumber(redis.call('HGET', KEYS[1], 'limitOverride') or ARGV[2])
if used + amount > limit or (tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3])) then
 redis.call('HSET', KEYS[1], 'blockedRequired', amount)
 redis.call('EXPIRE', KEYS[1], ARGV[4])
 return 0
end
redis.call('HDEL', KEYS[1], 'blockedRequired')
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[4])
for i=1,2 do
 redis.call('HINCRBY', KEYS[i], 'used', amount)
 redis.call('HINCRBY', KEYS[i], 'reserved', amount)
 redis.call('HINCRBY', KEYS[i], 'requests', 1)
 redis.call('EXPIRE', KEYS[i], ARGV[4])
end
return 1
`;
const settleScript = `
local raw = redis.call('GET', KEYS[3])
if not raw then return 0 end
local reserved = tonumber(raw)
for i=1,2 do
 redis.call('HINCRBY', KEYS[i], 'used', tonumber(ARGV[1]) - reserved)
 redis.call('HINCRBY', KEYS[i], 'reserved', -reserved)
 redis.call('HINCRBY', KEYS[i], 'promptTokens', ARGV[2])
 redis.call('HINCRBY', KEYS[i], 'completionTokens', ARGV[3])
 redis.call('HINCRBY', KEYS[i], 'cacheHitTokens', ARGV[4])
 redis.call('HINCRBY', KEYS[i], 'settled', 1)
end
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
const budgetStatus = async (config, scope) => {
	const redis = await budgetRedis();
	const day = await redisDay(redis);
	const [key, totalKey] = keysFor(day, scope);
	const [value, total] = await bounded(Promise.all([redis.hgetall(key), redis.hgetall(totalKey)]));
	const limit = value.limitOverride === void 0 ? budgetLimit(config, scope) : Number(value.limitOverride);
	const used = Number(value.used || 0);
	const required = Number(value.blockedRequired || 0);
	const globalUsed = Number(total.used || 0);
	const globalLimit = Math.floor((config.budget?.globalDailyYuan ?? 0) * units);
	return {
		day,
		blocked: used >= limit || used + required > limit || globalLimit > 0 && (globalUsed >= globalLimit || globalUsed + required > globalLimit),
		limit: limit / units,
		defaultLimit: budgetLimit(config, scope) / units,
		used: used / units,
		remaining: Math.max(0, limit - used) / units,
		reserved: Number(value.reserved || 0) / units,
		requests: Number(value.requests || 0),
		promptTokens: Number(value.promptTokens || 0),
		completionTokens: Number(value.completionTokens || 0),
		cacheHitTokens: Number(value.cacheHitTokens || 0),
		globalUsed: Number(total.used || 0) / units
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
const budgetedFetch = async (config, url, init) => {
	if (!budgetEnabled(config)) return fetch(url, init);
	init.signal?.throwIfAborted();
	const scope = context.getStore();
	if (!scope?.channelId || !scope.platform) throw new DSHError("budget", "无法确定本次调用所属会话，已暂停付费调用。");
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
	const keys = [...keysFor(day, scope), `${prefix}:${day}:request:${randomUUID()}`];
	const admitted = await bounded(redis.eval(reserveScript, 3, ...keys, amount, budgetLimit(config, scope), Math.floor((config.budget?.globalDailyYuan ?? 0) * units), ttl));
	if (Number(admitted) !== 1) throw new BudgetExceededError();
	init.signal?.throwIfAborted();
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
		await bounded(redis.eval(settleScript, 3, ...keys, usageCost(counted, rates), counted.prompt_tokens, counted.completion_tokens, counted.prompt_cache_hit_tokens || 0));
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
local before = tonumber(redis.call('HGET', KEYS[1], 'limitOverride') or ARGV[1])
local amount = tonumber(ARGV[3])
local after = ARGV[2] == 'add' and before + amount or amount
if after < 0 or after > 10000000000 then return 'invalid' end
local entry = cjson.encode({fingerprint=ARGV[7], day=ARGV[6], at=tonumber(redis.call('TIME')[1]), actor=ARGV[4], operation=ARGV[2], amount=amount, before=before, after=after, used=tonumber(redis.call('HGET', KEYS[1], 'used') or '0')})
redis.call('HSET', KEYS[1], 'limitOverride', after)
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
	if (result === "invalid") throw new DSHError("budget", "调整后的今日总额度必须在 0–10000 元之间。");
	return JSON.parse(result);
};
const budgetAdjustments = async (scope, isMaster) => {
	if (!isMaster) throw new DSHError("budget", "只有机器人主人可以查看额度调整记录。");
	const redis = await budgetRedis();
	const [key] = keysFor(await redisDay(redis), scope);
	return (await bounded(redis.lrange(`${key}:adjustments`, 0, 4))).map((row) => JSON.parse(row));
};
const budgetExceededMessage = "今日可用额度不足，暂时无法继续回复。请联系机器人主人充值或增加今日额度，也可等待北京时间零点刷新。发送 /额度 查看剩余额度。";
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
const assertBudgetAvailable = async (config) => {
	if (!budgetEnabled(config)) return;
	const scope = context.getStore();
	if (!scope?.platform || !scope.channelId) throw new DSHError("budget", "无法确定本次调用所属会话。");
	if ((await budgetStatus(config, scope)).blocked) throw new BudgetExceededError();
};
const reserveWorkspaceText = async (config, input) => {
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
	const keys = [...keysFor(day, scope), `${prefix}:${day}:request:${randomUUID()}`];
	if (Number(await bounded(redis.eval("\nlocal amount = tonumber(ARGV[1])\nlocal used = tonumber(redis.call('HGET', KEYS[1], 'used') or '0')\nlocal total = tonumber(redis.call('HGET', KEYS[2], 'used') or '0')\nlocal limit = tonumber(redis.call('HGET', KEYS[1], 'limitOverride') or ARGV[2])\nif used + amount > limit or (tonumber(ARGV[3]) > 0 and total + amount > tonumber(ARGV[3])) then\n redis.call('HSET', KEYS[1], 'blockedRequired', amount)\n redis.call('EXPIRE', KEYS[1], ARGV[4])\n return 0\nend\nredis.call('HDEL', KEYS[1], 'blockedRequired')\nif redis.call('EXISTS', KEYS[3]) == 1 then return 0 end\nredis.call('SET', KEYS[3], ARGV[1], 'EX', ARGV[4])\nfor i=1,2 do\n redis.call('HINCRBY', KEYS[i], 'used', amount)\n redis.call('HINCRBY', KEYS[i], 'reserved', amount)\n redis.call('HINCRBY', KEYS[i], 'requests', 1)\n redis.call('EXPIRE', KEYS[i], ARGV[4])\nend\nreturn 1\n", 3, ...keys, amount, budgetLimit(config, scope), Math.floor((config.budget?.globalDailyYuan ?? 0) * units), ttl))) !== 1) throw new BudgetExceededError();
	return async (output) => {
		const usage = {
			prompt_tokens: promptTokens,
			completion_tokens: Math.ceil(Buffer.byteLength(output) / 3)
		};
		await bounded(redis.eval(settleScript, 3, ...keys, usageCost(usage, rates), usage.prompt_tokens, usage.completion_tokens, 0));
	};
};

export { BudgetExceededError, assertBudgetAvailable, budgetAdjustments, budgetDay, budgetEnabled, budgetExceededMessage, budgetLimit, budgetNoticeScript, budgetRedis, budgetStatus, budgetedFetch, claimBudgetNotice, manageBudget, manageBudgetScript, officialRates, parseUsage, reserveScript, reserveWorkspaceText, settleScript, textBudgetInput, usageCost, withBudgetScope };