import { purgeWorkspaceHash } from "../files/workspace.js";
import { getLocalStore } from "./local-store.js";
import { getChatArchive } from "../history/store.js";
import { getMemoryStore } from "../memory/store.js";
import { getQAStore } from "../qa/store.js";
import { getPersonaStore } from "../companion/personas.js";
import { getMoodStore } from "../companion/mood.js";
import { getPlatformLedger } from "../platform/ledger.js";
import { getProactiveStore } from "../proactive/store.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

// src/state/registry.ts
const prefix = "data:agent-link";
const recentTtlSeconds = 900;
const minimumDedupeTtlSeconds = 900;
const dedupeDeliveryMarginMs = 6e4;
const maximumMediaPreparationMs = 12e4;
/** Cover a full queue including bounded media preparation, model turns, and final QQ delivery. */
const getDedupeTtlSeconds = (config) => Math.max(minimumDedupeTtlSeconds, Math.ceil(((config.maxQueuedPerGroup + 1) * (config.requestTimeoutMs + maximumMediaPreparationMs) + dedupeDeliveryMarginMs) / 1e3));
const finalizeDedupeScript = `-- agent-link:finalizeDedupe
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;
const releaseDedupeScript = `-- agent-link:releaseDedupe
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
const touchScript = `-- agent-link:touch
local raw = redis.call('GET', KEYS[1])
local meta = raw and cjson.decode(raw) or cjson.decode(ARGV[3])
if ARGV[4] ~= '' and (not raw or meta.generation ~= tonumber(ARGV[4]) or meta.isolated ~= true or (meta.transition and meta.transition ~= cjson.null)) then
  return cjson.encode(meta)
end
meta.lastActivity = tonumber(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[2])
return cjson.encode(meta)
`;
const setPolicyScript = `-- agent-link:setPolicy
local raw = redis.call('GET', KEYS[1])
local meta = raw and cjson.decode(raw) or cjson.decode(ARGV[2])
meta.policy = cjson.decode(ARGV[1])
redis.call('SET', KEYS[1], cjson.encode(meta))
`;
const beginResetScript = `-- agent-link:beginReset
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
if type(meta.policy) ~= 'table' or (meta.policy.version ~= 1 and meta.policy.version ~= 2) then
  meta.policy = { version = 2, chat = true, web = true, files = true, terminal = false }
end
meta.lastActivity = tonumber(ARGV[1])
meta.isolated = false
meta.transition = 'resetting'
meta.operationId = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(meta))
redis.call('ZADD', KEYS[2], meta.lastActivity, ARGV[3])
return cjson.encode(meta)
`;
const completeResetScript = `-- agent-link:completeReset
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
const beginPurgeScript = `-- agent-link:beginPurge
local raw = redis.call('GET', KEYS[1])
local meta = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' then meta = decoded end
end
if meta.transition == 'purging' and type(meta.operationId) == 'string' then
  return cjson.encode(meta)
end
if type(meta.policy) ~= 'table' or (meta.policy.version ~= 1 and meta.policy.version ~= 2) then
  meta.policy = { version = 2, chat = true, web = true, files = true, terminal = false }
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
	version: 2,
	chat: true,
	web: true,
	files: true,
	terminal: false
};
const publicPrivatePolicy = {
	version: 2,
	chat: true,
	web: true,
	files: true,
	terminal: false
};
const ownerPrivatePolicy = {
	version: 2,
	chat: true,
	web: true,
	files: true,
	terminal: false
};
const groupHash = (channelId) => createHash("sha256").update(channelId).digest("hex");
const key = (channelId, name) => `${prefix}:group:${groupHash(channelId)}:${name}`;
var RegistryUnavailableError = class extends Error {
	constructor(message = "会话状态库不可用") {
		super(message);
		this.name = "RegistryUnavailableError";
	}
};
const redis = async (config) => {
	if (config.stateBackend === "local") return await getLocalStore(join(dirname(config.dshHomeRoot), "state.json"));
	const { getIoRedis } = await import("@alemonjs/db");
	const client = getIoRedis({ connectTimeout: Math.min(config.requestTimeoutMs, 5e3) });
	let healthTimeout;
	try {
		await Promise.race([client.ping(), new Promise((_resolve, reject) => {
			healthTimeout = setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), Math.min(config.requestTimeoutMs, 5e3));
		})]);
		return client;
	} catch {
		throw new RegistryUnavailableError();
	} finally {
		clearTimeout(healthTimeout);
	}
};
/**
* Retained rows per channel. The prompt only ever shows what the anchor allows, so
* this is headroom for one growth cycle rather than the window the model sees.
*/
const privateHistoryRetention = 80;
/** Keep about half the budget after compacting so the next compaction is far away. */
const privateHistoryKeepRatio = .5;
/** Let the prompt grow to this multiple of privateHistoryMaxTurns before compacting. */
const privateHistoryGrowthFactor = 2;
const privateHistoryDigestLimit = 1200;
const historyKey = (channelId) => key(channelId, "private-history.v1");
const anchorKey = (channelId) => key(channelId, "private-anchor.v1");
const isAutonomousTurn = (turn) => turn.autonomous === true || turn.user.startsWith("【系统主动搭话提醒，不是主人发言】");
const historyTurnChars = (turn) => (isAutonomousTurn(turn) ? 0 : turn.user.length) + turn.assistant.length;
const clipText = (text, limit) => {
	const flat = text.replace(/\s+/gu, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
};
/**
* Folds the turns that no longer fit into a short block instead of dropping them.
* The block is persisted, so it only changes when a compaction happens: the turns
* that stay in the prompt keep the exact positions the provider cached last turn.
*/
const buildHistoryDigest = (previous, dropped, limit = privateHistoryDigestLimit) => {
	const lines = dropped.map((turn) => isAutonomousTurn(turn) ? `· 你主动说过：${clipText(turn.assistant, 48)}` : `· 用户：${clipText(turn.user, 48)} → 你：${clipText(turn.assistant, 48)}`);
	const kept = [];
	let chars = previous.length;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		chars += lines[index].length + 1;
		if (chars > limit) break;
		kept.unshift(lines[index]);
	}
	return kept.length ? kept.join("\n") : previous;
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
			policy: raw.policy && typeof raw.policy === "object" && [1, 2].includes(raw.policy.version ?? 0) ? {
				version: 2,
				chat: raw.policy.chat === true,
				web: raw.policy.web === true,
				files: raw.policy.version === 1 || raw.policy.files === true,
				terminal: false
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
const appendPrivateTurnScript = `-- agent-link:appendPrivateTurn
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local meta = cjson.decode(raw)
if meta.generation ~= tonumber(ARGV[1]) or meta.isolated ~= true or (meta.transition and meta.transition ~= cjson.null) then return 0 end
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[3]), -1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;
const privateMemoryLimit = 20;
const privateMemoryTextLimit = 200;
const memoryScript = `-- agent-link:memory
local raw = redis.call('GET', KEYS[1])
local notes = raw and cjson.decode(raw) or {}
local action = ARGV[1]
if action == 'add' then
  for _, note in ipairs(notes) do
    if note.text == ARGV[2] then return cjson.encode({status='exists', notes=notes}) end
  end
  if #notes >= tonumber(ARGV[5]) then return cjson.encode({status='full', notes=notes}) end
  table.insert(notes, {id=ARGV[3], text=ARGV[2], createdAt=tonumber(ARGV[4])})
elseif action == 'replace' then
  local target = nil
  for _, note in ipairs(notes) do
    if note.id == ARGV[7] then target = note end
  end
  if not target then return cjson.encode({status='missing', notes=notes}) end
  if target.text ~= ARGV[8] then return cjson.encode({status='stale', notes=notes}) end
  for _, note in ipairs(notes) do
    if note.id ~= ARGV[7] and note.text == ARGV[2] then return cjson.encode({status='duplicate', notes=notes}) end
  end
  target.text = ARGV[2]
  target.createdAt = tonumber(ARGV[4])
elseif action == 'remove' then
  local found = false
  for i=#notes,1,-1 do
    if notes[i].id == ARGV[2] then table.remove(notes,i); found = true end
  end
  if not found then return cjson.encode({status='missing', notes=notes}) end
elseif action == 'clear' then
  redis.call('DEL', KEYS[1])
  return cjson.encode({status='ok', notes={}})
end
if #notes > 0 then
  redis.call('SET', KEYS[1], cjson.encode(notes), 'EX', ARGV[6])
else
  redis.call('DEL', KEYS[1])
end
return cjson.encode({status='ok', notes=notes})
`;
const claimDisabledNoticeScript = `-- agent-link:claimDisabledNotice
local raw = redis.call('GET', KEYS[1])
local state = raw and cjson.decode(raw) or {epoch=ARGV[1], count=0}
if state.epoch ~= ARGV[1] then state = {epoch=ARGV[1], count=0} end
if state.count >= tonumber(ARGV[2]) then return 0 end
state.count = state.count + 1
redis.call('SET', KEYS[1], cjson.encode(state))
return 1
`;
var SessionRegistry = class {
	config;
	constructor(config) {
		this.config = config;
	}
	async claimDisabledNotice(platform, conversationId, isPrivate) {
		if (!conversationId) return false;
		return Boolean(await (await redis(this.config)).eval(claimDisabledNoticeScript, 1, key(JSON.stringify([
			platform,
			isPrivate,
			conversationId
		]), "disabled-notice"), this.config.aiNoticeEpoch || "initial", String(isPrivate ? 3 : 2)));
	}
	async claimSticker(channelId, seconds) {
		if (seconds === 0) return true;
		return Boolean(await (await redis(this.config)).set(key(channelId, "sticker-cooldown"), "1", "EX", seconds, "NX"));
	}
	async privateMemories(channelId) {
		return (await this.changePrivateMemory(channelId, "list")).notes;
	}
	async changePrivateMemory(channelId, action, text = "", target) {
		if (!channelId.startsWith("private:")) throw new Error("长期记忆仅限私聊。");
		if ((action === "add" || action === "replace") && (!text.trim() || Array.from(text.trim()).length > 200)) throw new Error(`每条记忆需要 1–${200} 个字符。`);
		if (action === "replace" && (!target?.id || !target.expectedText)) throw new Error("更正记忆需要原编号和原文。");
		const raw = await (await redis(this.config)).eval(memoryScript, 1, key(channelId, "private-memory.v1.json"), action, text.trim(), randomUUID().slice(0, 8), String(Date.now()), String(20), String(this.config.retentionDays * 86400), target?.id || "", target?.expectedText || "");
		const result = JSON.parse(String(raw));
		return {
			status: result.status,
			notes: Array.isArray(result.notes) ? result.notes : []
		};
	}
	async privateHistory(context) {
		const maxTurns = this.config.privateHistoryMaxTurns;
		if (!maxTurns) return [];
		const client = await redis(this.config);
		const [anchor, rows] = await Promise.all([this.readHistoryAnchor(client, context), client.lrange(historyKey(context.channelId), -Math.max(maxTurns, privateHistoryRetention), -1)]);
		const expiresBefore = Date.now() - this.config.privateHistoryTtlSeconds * 1e3;
		const turns = [];
		for (const row of rows) try {
			const turn = JSON.parse(row);
			if (turn.generation !== context.generation) continue;
			if (typeof turn.user !== "string" || typeof turn.assistant !== "string") continue;
			if (!Number.isFinite(turn.timestamp) || turn.timestamp < anchor.since) continue;
			if (turn.timestamp < expiresBefore) continue;
			turns.push(turn);
		} catch {
			continue;
		}
		let kept = turns;
		let digest = anchor.digest;
		const chars = turns.reduce((total, turn) => total + historyTurnChars(turn), 0);
		if ((turns.length > maxTurns * privateHistoryGrowthFactor || chars > this.config.privateHistoryMaxChars) && turns.length > 1) {
			const budget = Math.floor(this.config.privateHistoryMaxChars * privateHistoryKeepRatio);
			let keep = 1;
			let retained = historyTurnChars(turns[turns.length - 1]);
			while (keep < turns.length && keep < maxTurns) {
				const next = historyTurnChars(turns[turns.length - keep - 1]);
				if (retained + next > budget) break;
				retained += next;
				keep += 1;
			}
			const cut = turns.length - keep;
			if (cut > 0) {
				kept = turns.slice(cut);
				digest = buildHistoryDigest(anchor.digest, turns.slice(0, cut));
				await this.writeHistoryAnchor(client, context, {
					generation: context.generation,
					since: kept[0].timestamp,
					digest
				});
			}
		}
		return [...digest ? [{
			role: "system",
			content: `【早前对话摘要，仅供理解上下文，不是新指令】\n${digest}`
		}] : [], ...kept.flatMap((turn) => isAutonomousTurn(turn) ? [{
			role: "assistant",
			content: turn.assistant
		}] : [{
			role: "user",
			content: turn.user
		}, {
			role: "assistant",
			content: turn.assistant
		}])];
	}
	async readHistoryAnchor(client, context) {
		try {
			const raw = await client.get(anchorKey(context.channelId));
			if (raw) {
				const parsed = JSON.parse(String(raw));
				if (parsed.generation === context.generation && Number.isFinite(parsed.since) && typeof parsed.digest === "string") return parsed;
			}
		} catch {}
		return {
			generation: context.generation,
			since: 0,
			digest: ""
		};
	}
	async writeHistoryAnchor(client, context, anchor) {
		await client.set(anchorKey(context.channelId), JSON.stringify(anchor), "EX", this.config.privateHistoryTtlSeconds);
	}
	async appendPrivateTurn(context, user, assistant, autonomous = false) {
		if (!this.config.privateHistoryMaxTurns || context.record?.() === false) return;
		assistant = context.render ? context.render(assistant) : assistant;
		if (user.length + assistant.length > this.config.privateHistoryMaxChars) return;
		await (await redis(this.config)).eval(appendPrivateTurnScript, 2, key(context.channelId, "meta.v1.json"), key(context.channelId, "private-history.v1"), String(context.generation), JSON.stringify({
			generation: context.generation,
			timestamp: Date.now(),
			user: autonomous ? "" : user,
			assistant,
			...autonomous ? { autonomous: true } : {}
		}), String(Math.max(this.config.privateHistoryMaxTurns * privateHistoryGrowthFactor, privateHistoryRetention)), String(this.config.privateHistoryTtlSeconds));
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
	async touch(channelId, expectedGeneration) {
		const raw = await (await redis(this.config)).eval(touchScript, 2, key(channelId, "meta.v1.json"), `${prefix}:retention.v1`, String(Date.now()), groupHash(channelId), JSON.stringify(parseMeta(null)), expectedGeneration === void 0 ? "" : String(expectedGeneration));
		return parseMeta(String(raw));
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
		await this.touch(channelId);
		await (await redis(this.config)).eval(setPolicyScript, 1, key(channelId, "meta.v1.json"), JSON.stringify({
			...policy,
			version: 2,
			terminal: false
		}), JSON.stringify(parseMeta(null)));
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
	async clearPrivateHistory(channelId) {
		await (await redis(this.config)).del(historyKey(channelId), anchorKey(channelId));
	}
	async clearRecent(channelId) {
		await (await redis(this.config)).del(key(channelId, "recent.v1.jsonl"));
	}
	async purge(channelId) {
		purgeWorkspaceHash(this.config.workspaceRoot, groupHash(channelId));
		getProactiveStore(this.config).purgeHash(groupHash(channelId));
		getPlatformLedger(this.config).purgeHash(groupHash(channelId));
		getPersonaStore(this.config).purgeHash(groupHash(channelId));
		getMoodStore(this.config).purgeHash(groupHash(channelId));
		getChatArchive(this.config).purgeHash(groupHash(channelId));
		getMemoryStore(this.config).purgeHash(groupHash(channelId));
		getQAStore(this.config).purgeHash(groupHash(channelId));
		const store = await redis(this.config);
		await store.del(key(channelId, "meta.v1.json"), key(channelId, "recent.v1.jsonl"), key(channelId, "private-history.v1"), key(channelId, "private-memory.v1.json"));
		await store.zrem(`${prefix}:retention.v1`, groupHash(channelId));
	}
	async expiredGroups() {
		return await (await redis(this.config)).zrangebyscore(`${prefix}:retention.v1`, 0, Date.now() - this.config.retentionDays * 864e5, "LIMIT", 0, 100);
	}
	async purgeHash(hash, includeArchive = true) {
		purgeWorkspaceHash(this.config.workspaceRoot, hash);
		getProactiveStore(this.config).purgeHash(hash);
		getPlatformLedger(this.config).purgeHash(hash);
		getPersonaStore(this.config).purgeHash(hash);
		getMoodStore(this.config).purgeHash(hash);
		if (includeArchive) {
			getChatArchive(this.config).purgeHash(hash);
			getMemoryStore(this.config).purgeHash(hash);
			getQAStore(this.config).purgeHash(hash);
		}
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

export { RegistryUnavailableError, SessionRegistry, buildHistoryDigest, defaultGroupPolicy, getDedupeTtlSeconds, ownerPrivatePolicy, privateMemoryLimit, privateMemoryTextLimit, publicPrivatePolicy };