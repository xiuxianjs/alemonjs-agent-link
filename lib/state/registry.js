import { createHash, randomUUID } from "node:crypto";
import { getIoRedis } from "@alemonjs/db";

//#region src/state/registry.ts
const prefix = "data:agent-link";
const recentTtlSeconds = 900;
const minimumDedupeTtlSeconds = 900;
const dedupeDeliveryMarginMs = 6e4;
/** Cover a full group queue, its own model turn, and final QQ delivery. */
const getDedupeTtlSeconds = (config) => Math.max(minimumDedupeTtlSeconds, Math.ceil(((config.maxQueuedPerGroup + 1) * config.requestTimeoutMs + dedupeDeliveryMarginMs) / 1e3));
const finalizeDedupeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;
const releaseDedupeScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
const beginResetScript = `
local raw = redis.call('GET', KEYS[1])
local meta = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then meta = decoded end
end
if meta.transition == 'resetting' and type(meta.operationId) == 'string' then
  return cjson.encode(meta)
end
meta.generation = (tonumber(meta.generation) or 0) + 1
if type(meta.policy) ~= 'table' or meta.policy.version ~= 1 then
  meta.policy = { version = 1, chat = true, web = true, files = false, terminal = false }
end
meta.lastActivity = tonumber(ARGV[1])
meta.isolated = false
meta.transition = 'resetting'
meta.operationId = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[3])
return cjson.encode(meta)
`;
const completeResetScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, meta = pcall(cjson.decode, raw)
if not ok or type(meta) ~= 'table' then return 0 end
if meta.transition ~= 'resetting' or meta.operationId ~= ARGV[1] then return 0 end
meta.isolated = true
meta.transition = cjson.null
meta.operationId = cjson.null
redis.call('SET', KEYS[1], cjson.encode(meta))
return 1
`;
const beginPurgeScript = `
local raw = redis.call('GET', KEYS[1])
local meta = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then meta = decoded end
end
if meta.transition == 'purging' and type(meta.operationId) == 'string' then
  return cjson.encode(meta)
end
if type(meta.policy) ~= 'table' or meta.policy.version ~= 1 then
  meta.policy = { version = 1, chat = true, web = true, files = false, terminal = false }
end
meta.lastActivity = tonumber(ARGV[1])
meta.isolated = false
meta.transition = 'purging'
meta.operationId = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[3])
return cjson.encode(meta)
`;
const defaultGroupPolicy = {
	version: 1,
	chat: true,
	web: true,
	files: false,
	terminal: false
};
const ownerPrivatePolicy = {
	version: 1,
	chat: true,
	web: true,
	files: true,
	terminal: true
};
const groupHash = (channelId) => createHash("sha256").update(channelId).digest("hex");
const key = (channelId, name) => `${prefix}:group:${groupHash(channelId)}:${name}`;
var RegistryUnavailableError = class extends Error {
	constructor(message = "Redis 不可用") {
		super(message);
		this.name = "RegistryUnavailableError";
	}
};
const redis = async (config) => {
	const client = getIoRedis({ connectTimeout: Math.min(config.requestTimeoutMs, 5e3) });
	try {
		await Promise.race([client.ping(), new Promise((_resolve, reject) => setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), Math.min(config.requestTimeoutMs, 5e3)))]);
		return client;
	} catch {
		throw new RegistryUnavailableError();
	}
};
const parseMeta = (value) => {
	if (!value) return {
		generation: 0,
		policy: defaultGroupPolicy,
		lastActivity: Date.now(),
		isolated: false
	};
	try {
		const raw = JSON.parse(value);
		return {
			generation: Number.isInteger(raw.generation) ? raw.generation : 0,
			policy: raw.policy && typeof raw.policy === "object" && raw.policy.version === 1 ? {
				version: 1,
				chat: raw.policy.chat === true,
				web: raw.policy.web === true,
				files: raw.policy.files === true,
				terminal: raw.policy.terminal === true
			} : defaultGroupPolicy,
			lastActivity: typeof raw.lastActivity === "number" ? raw.lastActivity : Date.now(),
			isolated: raw.isolated === true,
			transition: raw.transition === "resetting" || raw.transition === "purging" ? raw.transition : void 0,
			operationId: typeof raw.operationId === "string" ? raw.operationId : void 0
		};
	} catch {
		return {
			generation: 0,
			policy: defaultGroupPolicy,
			lastActivity: Date.now(),
			isolated: false
		};
	}
};
var SessionRegistry = class {
	config;
	constructor(config) {
		this.config = config;
	}
	async ready() {
		await redis(this.config);
	}
	async health() {
		try {
			await redis(this.config);
			return true;
		} catch {
			return false;
		}
	}
	async groupKey(channelId) {
		return await Promise.resolve(groupHash(channelId));
	}
	async meta(channelId) {
		return parseMeta(await (await redis(this.config)).get(key(channelId, "meta.v1.json")));
	}
	async touch(channelId) {
		const store = await redis(this.config);
		const meta = await this.meta(channelId);
		meta.lastActivity = Date.now();
		await store.multi().set(key(channelId, "meta.v1.json"), JSON.stringify(meta)).zadd(`${prefix}:retention.v1`, meta.lastActivity, groupHash(channelId)).exec();
		return meta;
	}
	async beginReset(channelId) {
		const timestamp = Date.now();
		const raw = await (await redis(this.config)).eval(beginResetScript, 2, key(channelId, "meta.v1.json"), `${prefix}:retention.v1`, String(timestamp), randomUUID(), groupHash(channelId));
		return parseMeta(String(raw));
	}
	async completeReset(channelId, operationId) {
		return Number(await (await redis(this.config)).eval(completeResetScript, 1, key(channelId, "meta.v1.json"), operationId)) === 1;
	}
	async beginPurge(channelId) {
		const timestamp = Date.now();
		const raw = await (await redis(this.config)).eval(beginPurgeScript, 2, key(channelId, "meta.v1.json"), `${prefix}:retention.v1`, String(timestamp), randomUUID(), groupHash(channelId));
		return parseMeta(String(raw));
	}
	async policy(channelId) {
		return (await this.meta(channelId)).policy;
	}
	async setPolicy(channelId, policy) {
		const meta = await this.touch(channelId);
		meta.policy = policy;
		await (await redis(this.config)).set(key(channelId, "meta.v1.json"), JSON.stringify(meta));
	}
	async deduplicate(channelId, messageId) {
		const requestId = randomUUID();
		if (!messageId) return {
			duplicate: false,
			requestId
		};
		return {
			duplicate: !await (await redis(this.config)).set(this.dedupeKey(channelId, messageId), `running:${requestId}`, "EX", getDedupeTtlSeconds(this.config), "NX"),
			requestId
		};
	}
	async finalizeDeduplication(channelId, messageId, requestId) {
		if (!messageId) return true;
		return Number(await (await redis(this.config)).eval(finalizeDedupeScript, 1, this.dedupeKey(channelId, messageId), `running:${requestId}`, `delivered:${requestId}`, String(getDedupeTtlSeconds(this.config)))) === 1;
	}
	async releaseDeduplication(channelId, messageId, requestId) {
		if (!messageId) return;
		await (await redis(this.config)).eval(releaseDedupeScript, 1, this.dedupeKey(channelId, messageId), `running:${requestId}`);
	}
	async allowUser(channelId, userId) {
		const store = await redis(this.config);
		const now = Date.now();
		const rateKey = `${prefix}:rate:${groupHash(channelId)}:${createHash("sha256").update(userId).digest("hex")}`;
		const result = await store.multi().zremrangebyscore(rateKey, 0, now - 6e4).zadd(rateKey, now, randomUUID()).zcard(rateKey).expire(rateKey, 61).exec();
		return Number(result?.[2]?.[1] ?? 0) <= this.config.maxCallsPerUserPerMinute;
	}
	async recordRecent(channelId, message) {
		const text = message.text.replace(/\s+/g, " ").trim();
		if (!text || this.config.recentChatMaxMessages === 0) return;
		const store = await redis(this.config);
		const recentKey = key(channelId, "recent.v1.jsonl");
		await store.multi().rpush(recentKey, JSON.stringify({
			id: message.id,
			text,
			timestamp: message.timestamp ?? Date.now()
		})).ltrim(recentKey, -this.config.recentChatMaxMessages, -1).expire(recentKey, Math.min(recentTtlSeconds, this.config.recentChatWindowSeconds)).exec();
	}
	async recent(channelId, excludedMessageId) {
		if (this.config.recentChatMaxMessages === 0 || this.config.recentChatMaxChars === 0) return [];
		const rows = await (await redis(this.config)).lrange(key(channelId, "recent.v1.jsonl"), 0, -1);
		const cutoff = Date.now() - this.config.recentChatWindowSeconds * 1e3;
		const parsed = rows.flatMap((row) => {
			try {
				const value = JSON.parse(row);
				return typeof value.text === "string" && value.timestamp >= cutoff && value.id !== excludedMessageId ? [value] : [];
			} catch {
				return [];
			}
		});
		let chars = 0;
		const output = [];
		for (const item of parsed.toReversed()) {
			const remaining = this.config.recentChatMaxChars - chars;
			if (remaining <= 0) break;
			const text = item.text.slice(0, remaining);
			output.unshift({
				...item,
				text
			});
			chars += text.length;
		}
		return output;
	}
	async clearRecent(channelId) {
		await (await redis(this.config)).del(key(channelId, "recent.v1.jsonl"));
	}
	async purge(channelId) {
		const store = await redis(this.config);
		await store.del(key(channelId, "meta.v1.json"), key(channelId, "recent.v1.jsonl"));
		await store.zrem(`${prefix}:retention.v1`, groupHash(channelId));
	}
	async expiredGroups() {
		return await (await redis(this.config)).zrangebyscore(`${prefix}:retention.v1`, 0, Date.now() - this.config.retentionDays * 864e5, "LIMIT", 0, 100);
	}
	async purgeHash(hash) {
		const store = await redis(this.config);
		let cursor = "0";
		do {
			const [next, keys] = await store.scan(cursor, "MATCH", `${prefix}:group:${hash}:*`, "COUNT", 100);
			cursor = next;
			if (keys.length) await store.del(...keys);
		} while (cursor !== "0");
		await store.zrem(`${prefix}:retention.v1`, hash);
	}
	dedupeKey(channelId, messageId) {
		return `${prefix}:dedupe:${groupHash(channelId)}:${messageId}`;
	}
};

//#endregion
export { RegistryUnavailableError, SessionRegistry, defaultGroupPolicy, getDedupeTtlSeconds, ownerPrivatePolicy };