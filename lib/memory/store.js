import { conversationDataKey, conversationDataNamespace } from "../dsh/conversation-scope.js";
import { rankMemories, rankMemoriesHybrid, tokenizeMemory } from "./retrieval.js";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// src/memory/store.ts
const hash = (text) => createHash("sha256").update(text).digest("hex");
const normalize = (text) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
const experienceMemoryId = (key) => hash(JSON.stringify(["experience", key])).slice(0, 12);
const scopeKey = (scope, namespace) => {
	if (!scope.platform || !scope.channelId) throw new Error("记忆缺少平台或会话标识。");
	return conversationDataKey(scope, namespace);
};
const connectedMemoryIds = (items, target, includeEvidence) => {
	const edges = /* @__PURE__ */ new Map();
	const sourceOwners = /* @__PURE__ */ new Map();
	const textOwners = /* @__PURE__ */ new Map();
	const connect = (one, two) => {
		if (!edges.has(one)) edges.set(one, /* @__PURE__ */ new Set());
		if (!edges.has(two)) edges.set(two, /* @__PURE__ */ new Set());
		edges.get(one).add(two);
		edges.get(two).add(one);
	};
	for (const item of items.filter((entry) => entry.subjectId === target.subjectId)) {
		item.supersedes.forEach((parent) => connect(item.id, parent));
		if (!includeEvidence) continue;
		const normalized = normalize(item.text);
		const sameText = textOwners.get(normalized);
		if (sameText) connect(item.id, sameText);
		textOwners.set(normalized, item.id);
		for (const source of item.sourceRefs) {
			const sameSource = sourceOwners.get(source.seq);
			if (sameSource) connect(item.id, sameSource);
			sourceOwners.set(source.seq, item.id);
		}
	}
	const found = /* @__PURE__ */ new Set([target.id]);
	const queue = [target.id];
	for (let index = 0; index < queue.length; index++) for (const next of edges.get(queue[index]) || []) {
		if (found.has(next)) continue;
		found.add(next);
		queue.push(next);
	}
	return found;
};
var MemoryStore = class {
	now;
	dataNamespace;
	db;
	scopeId(scope) {
		return scopeKey(scope, this.dataNamespace);
	}
	get namespaceCondition() {
		return this.dataNamespace === void 0 ? "(data_namespace IS NULL OR data_namespace='')" : "data_namespace=?";
	}
	get namespaceArgs() {
		return this.dataNamespace === void 0 ? [] : [this.dataNamespace];
	}
	constructor(path, now = Date.now, dataNamespace) {
		this.now = now;
		this.dataNamespace = dataNamespace;
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`CREATE TABLE IF NOT EXISTS shared_checkpoints (scope TEXT NOT NULL,subject_id TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(scope,subject_id));
      CREATE TABLE IF NOT EXISTS shared_threads (
      scope TEXT NOT NULL,id TEXT NOT NULL,subject_id TEXT NOT NULL,revision INTEGER NOT NULL,
      payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(scope,id,revision));`);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS memory_scopes (
        scope TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL, group_hash TEXT NOT NULL,
        epoch TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, checkpoint INTEGER NOT NULL DEFAULT 0,
        last_run INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0, active_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_fallback_barriers (
        scope TEXT NOT NULL REFERENCES memory_scopes(scope) ON DELETE CASCADE,
        subject_id TEXT NOT NULL, skip_through INTEGER NOT NULL, PRIMARY KEY(scope,subject_id));
      CREATE TABLE IF NOT EXISTS memories (
        scope TEXT NOT NULL REFERENCES memory_scopes(scope) ON DELETE CASCADE, id TEXT NOT NULL,
        subject_id TEXT NOT NULL, subject_name TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, normalized TEXT NOT NULL,
        tags TEXT NOT NULL, importance REAL NOT NULL, confidence REAL NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
        sources TEXT NOT NULL, supersedes TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_recalled_at INTEGER NOT NULL DEFAULT 0, recall_days INTEGER NOT NULL DEFAULT 0, recall_day TEXT NOT NULL DEFAULT '',
        embedding BLOB, embedding_model TEXT, embedding_hash TEXT,
        PRIMARY KEY(scope,id));
      CREATE INDEX IF NOT EXISTS memory_status ON memories(scope,status,subject_id);
      CREATE INDEX IF NOT EXISTS memory_groups ON memory_scopes(group_hash);
      CREATE TABLE IF NOT EXISTS memory_recalls (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL REFERENCES memory_scopes(scope) ON DELETE CASCADE,
        at INTEGER NOT NULL, ids TEXT NOT NULL);`);
		const scopeColumns = new Set(this.db.prepare("PRAGMA table_info(memory_scopes)").all().map((row) => String(row.name)));
		if (!scopeColumns.has("bot_id")) this.db.exec("ALTER TABLE memory_scopes ADD COLUMN bot_id TEXT");
		if (!scopeColumns.has("data_namespace")) this.db.exec("ALTER TABLE memory_scopes ADD COLUMN data_namespace TEXT");
		this.db.exec("CREATE INDEX IF NOT EXISTS memory_namespace ON memory_scopes(data_namespace,last_run)");
		const columns = new Set(this.db.prepare("PRAGMA table_info(memories)").all().map((row) => String(row.name)));
		for (const [name, type] of [
			["embedding", "BLOB"],
			["embedding_model", "TEXT"],
			["embedding_hash", "TEXT"]
		]) if (!columns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
	}
	close() {
		this.db.close();
	}
	transactionDepth = 0;
	transaction(run) {
		if (this.transactionDepth > 0) return run();
		this.transactionDepth++;
		try {
			return this.outerTransaction(run);
		} finally {
			this.transactionDepth--;
		}
	}
	outerTransaction(run) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	observe(scope) {
		const key = this.scopeId(scope);
		const previous = this.db.prepare("SELECT active_at FROM memory_scopes WHERE scope=?").get(key);
		if (previous && Number(previous.active_at) < this.now() - 2592e6) this.db.prepare("DELETE FROM memory_scopes WHERE scope=?").run(key);
		this.db.prepare(`INSERT INTO memory_scopes(scope,platform,channel_id,group_hash,epoch,active_at,bot_id,data_namespace) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET active_at=excluded.active_at`).run(key, scope.platform, scope.channelId, hash(scope.channelId), randomUUID(), this.now(), this.dataNamespace !== void 0 || scope.botId !== void 0 ? scope.botId ?? "" : null, this.dataNamespace ?? (scope.botId !== void 0 ? "" : null));
	}
	state(scope) {
		const row = this.db.prepare("SELECT epoch,revision,checkpoint,last_run AS lastRun,retry_after AS retryAfter FROM memory_scopes WHERE scope=?").get(this.scopeId(scope));
		return row ? row : void 0;
	}
	due(intervalMs, limit = 4) {
		return this.db.prepare(`SELECT platform,channel_id AS channelId,bot_id AS botId FROM memory_scopes
      WHERE last_run<=? AND retry_after<=? AND ${this.namespaceCondition} ORDER BY last_run,active_at DESC LIMIT ?`).all(this.now() - intervalMs, this.now(), ...this.namespaceArgs, limit).map((row) => ({
			platform: String(row.platform),
			channelId: String(row.channelId),
			...row.botId === null ? {} : { botId: String(row.botId) }
		}));
	}
	fallbackAfter(scope, subjectId) {
		return Number(this.db.prepare("SELECT coalesce(max(skip_through),0) AS n FROM memory_fallback_barriers WHERE scope=? AND subject_id IN ('',?)").get(this.scopeId(scope), subjectId).n);
	}
	suppressFallback(scope, subjectId, through) {
		this.db.prepare(`INSERT INTO memory_fallback_barriers(scope,subject_id,skip_through) VALUES(?,?,?)
      ON CONFLICT(scope,subject_id) DO UPDATE SET skip_through=max(skip_through,excluded.skip_through)`).run(this.scopeId(scope), subjectId, through);
	}
	decode(row) {
		return {
			id: String(row.id),
			subjectId: String(row.subject_id),
			subjectName: String(row.subject_name),
			kind: row.kind,
			text: String(row.text),
			tags: JSON.parse(String(row.tags)),
			importance: Number(row.importance),
			confidence: Number(row.confidence),
			status: row.status,
			origin: row.origin,
			sourceRefs: JSON.parse(String(row.sources)),
			supersedes: JSON.parse(String(row.supersedes)),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at),
			lastRecalledAt: Number(row.last_recalled_at),
			recallDays: Number(row.recall_days)
		};
	}
	list(scope, options = {}) {
		return this.db.prepare(`SELECT * FROM memories WHERE scope=? AND (?='' OR status=?) AND (?='' OR subject_id=?)
      AND created_at<=? ORDER BY created_at DESC,id LIMIT ?`).all(this.scopeId(scope), options.status || "", options.status || "", options.subjectId || "", options.subjectId || "", options.before ?? Number.MAX_SAFE_INTEGER, Math.max(1, Math.min(10020, options.limit ?? 100))).map((row) => this.decode(row));
	}
	get(scope, id) {
		const row = this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=?").get(this.scopeId(scope), id);
		return row ? this.decode(row) : void 0;
	}
	sharedCheckpoint(scope, userId) {
		return Number(this.db.prepare("SELECT seq FROM shared_checkpoints WHERE scope=? AND subject_id=?").get(this.scopeId(scope), userId)?.seq || 0);
	}
	advanceSharedCheckpoint(scope, userId, seq) {
		this.db.prepare("INSERT INTO shared_checkpoints(scope,subject_id,seq) VALUES(?,?,?) ON CONFLICT(scope,subject_id) DO UPDATE SET seq=max(seq,excluded.seq)").run(this.scopeId(scope), userId, seq);
	}
	commitSharedBatch(scope, userId, expectedCheckpoint, through, changes, guard) {
		return this.transaction(() => {
			const current = this.state(scope);
			if (current?.epoch !== guard.epoch || current.revision !== guard.revision || this.sharedCheckpoint(scope, userId) !== expectedCheckpoint) return false;
			for (const change of changes) this.recordSharedThread(scope, userId, change);
			this.advanceSharedCheckpoint(scope, userId, through);
			return true;
		});
	}
	sharedThreads(scope, subjectId) {
		return this.db.prepare(`SELECT t.payload FROM shared_threads t WHERE t.scope=? AND t.subject_id=?
      AND t.revision=(SELECT max(revision) FROM shared_threads WHERE scope=t.scope AND id=t.id)
      ORDER BY t.updated_at DESC LIMIT 10`).all(this.scopeId(scope), subjectId).map((row) => JSON.parse(String(row.payload)));
	}
	recallSharedThreads(scope, subjectId, query, limit = 5) {
		const rows = this.db.prepare("SELECT payload FROM shared_threads WHERE scope=? AND subject_id=? ORDER BY revision DESC LIMIT 10000").all(this.scopeId(scope), subjectId).map((row) => JSON.parse(String(row.payload)));
		const tokens = new Set(tokenizeMemory(query));
		const groups = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const entry = groups.get(row.id);
			const text = `${row.text} ${row.sources.map((source) => source.text).join(" ")}`.toLowerCase();
			const score = [...tokens].reduce((sum, token) => sum + Number(text.includes(token)), 0);
			if (!entry) groups.set(row.id, {
				item: row,
				score
			});
			else entry.score = Math.max(entry.score, score);
		}
		const candidates = [...groups.values()];
		const topical = candidates.filter((entry) => entry.score > 0);
		return (topical.length ? topical : candidates.filter((entry) => entry.item.updatedAt >= this.now() - 864e5).sort((a, b) => b.item.updatedAt - a.item.updatedAt).slice(0, 1)).sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt).slice(0, Math.max(1, Math.min(20, limit))).map(({ item, score }) => ({
			...item,
			match: score > 0 ? "topic" : "recent",
			followUpEligible: item.state === "discussed" || item.state === "agreed"
		}));
	}
	sharedThreadHistory(scope, subjectId, id) {
		return this.db.prepare("SELECT payload FROM shared_threads WHERE scope=? AND subject_id=? AND id=? ORDER BY revision DESC LIMIT 20").all(this.scopeId(scope), subjectId, id).map((row) => JSON.parse(String(row.payload)));
	}
	recordSharedThread(scope, subjectId, input) {
		if (!subjectId || !input.text?.trim() || input.text.length > 800 || ![
			"discussed",
			"agreed",
			"cancelled",
			"claimed_done"
		].includes(input.state) || !input.sources.length || input.sources.length > 10 || !input.sources.some((source) => source.speakerId === subjectId)) throw new Error("共同经历缺少有效来源或状态。");
		this.observe(scope);
		return this.transaction(() => {
			const id = input.id || randomUUID().replaceAll("-", "").slice(0, 12);
			const old = this.sharedThreadHistory(scope, subjectId, id)[0];
			if (input.id && old?.revision !== input.expectedRevision) throw new Error("事项版本已变化，请重新读取。");
			if (old && Math.max(...input.sources.map((source) => source.seq)) <= Math.max(...old.sources.map((source) => source.seq))) throw new Error("更新事项必须提供更新的聊天证据。");
			const count = this.db.prepare("SELECT count(*) AS n FROM shared_threads WHERE scope=?").get(this.scopeId(scope));
			if (Number(count.n) >= 1e4) throw new Error("共同经历版本容量已满。");
			const duplicate = this.sharedThreads(scope, subjectId).find((item) => item.text === input.text.trim() && item.state === input.state);
			if (!input.id && duplicate) return duplicate;
			const item = {
				id,
				subjectId,
				revision: (old?.revision || 0) + 1,
				text: input.text.trim(),
				state: input.state,
				sources: input.sources,
				previousRevision: old?.revision || null,
				updatedAt: this.now(),
				evidenceType: "conversation_only"
			};
			this.db.prepare("INSERT INTO shared_threads(scope,id,subject_id,revision,payload,updated_at) VALUES(?,?,?,?,?,?)").run(this.scopeId(scope), id, subjectId, item.revision, JSON.stringify(item), item.updatedAt);
			return item;
		});
	}
	linkSharedExecution(scope, subjectId, id, expectedRevision, memoryId, botId) {
		return this.transaction(() => {
			const old = this.sharedThreadHistory(scope, subjectId, id)[0];
			const evidence = this.get(scope, memoryId);
			if (old?.revision !== expectedRevision) throw new Error("事项版本已变化，请重新读取。");
			if (evidence?.origin !== "event" || evidence.kind !== "event" || evidence.subjectId !== botId || evidence.status !== "active") throw new Error("缺少当前机器人真实执行经历。");
			if (old.execution?.memoryId === memoryId) return old;
			const item = {
				...old,
				revision: old.revision + 1,
				previousRevision: old.revision,
				updatedAt: this.now(),
				execution: {
					memoryId: evidence.id,
					text: evidence.text,
					at: evidence.createdAt
				},
				notice: "执行经历只证明记录中明确取得的结果，不代表整个约定已完成；取消状态保持有效。"
			};
			this.db.prepare("INSERT INTO shared_threads(scope,id,subject_id,revision,payload,updated_at) VALUES(?,?,?,?,?,?)").run(this.scopeId(scope), id, subjectId, item.revision, JSON.stringify(item), item.updatedAt);
			return item;
		});
	}
	recordExperience(scope, input, guard) {
		return this.recordPersonalEntry(scope, input, "event", guard);
	}
	recordDiary(scope, input, guard) {
		return this.recordPersonalEntry(scope, input, "diary", guard);
	}
	recordPersonalEntry(scope, input, origin, guard) {
		if (!input.key || input.key.length > 500 || !input.subjectId || input.subjectId.length > 200 || !input.text.trim() || input.text.length > 800 || input.tags.length > 10 || input.tags.some((tag) => typeof tag !== "string" || tag.length > 40)) throw new Error("经历资料无效。");
		this.observe(scope);
		return this.transaction(() => {
			const key = this.scopeId(scope);
			const state = this.state(scope);
			if (guard && (state?.epoch !== guard.epoch || state?.revision !== guard.revision)) return false;
			const id = origin === "event" ? experienceMemoryId(input.key) : hash(JSON.stringify(["diary", input.key])).slice(0, 12);
			const tags = [...input.tags];
			const readingIds = [.../* @__PURE__ */ new Set([...input.sourceReadingIds || [], ...input.sourceReadingId ? [input.sourceReadingId] : []])];
			if (readingIds.length > 3) return false;
			for (const readingId of origin === "diary" ? readingIds : []) {
				const parent = this.get(scope, readingId);
				if (parent?.status !== "active" || parent.origin !== "event" || parent.subjectId !== input.subjectId) return false;
				if (tags.length >= 10 || !/^[a-f0-9]{12}$/u.test(parent.id)) return false;
				tags.push(`reading:${parent.id}`);
			}
			if (this.db.prepare("SELECT id FROM memories WHERE scope=? AND id=?").get(key, id)) return false;
			const capacity = scope.channelId.startsWith("private:") ? 1980 : 2e3;
			const active = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit' AND status='active'").get(key);
			const total = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit'").get(key);
			if (Number(active.n) >= capacity || Number(total.n) >= 1e4) return false;
			this.insert(scope, {
				id,
				subjectId: input.subjectId,
				subjectName: "机器人",
				kind: origin,
				text: input.text.trim(),
				tags,
				importance: .5,
				confidence: origin === "event" ? 1 : .8,
				status: "active",
				origin,
				sourceRefs: [],
				supersedes: [],
				createdAt: this.now(),
				updatedAt: this.now(),
				lastRecalledAt: 0,
				recallDays: 0
			});
			this.db.prepare("UPDATE memory_scopes SET revision=revision+1 WHERE scope=?").run(key);
			return true;
		});
	}
	insert(scope, item) {
		this.db.prepare(`INSERT INTO memories(scope,id,subject_id,subject_name,kind,text,normalized,tags,importance,confidence,status,origin,sources,supersedes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET
      text=excluded.text,normalized=excluded.normalized,tags=excluded.tags,importance=excluded.importance,
      confidence=excluded.confidence,status=excluded.status,updated_at=excluded.updated_at,
      embedding=NULL,embedding_model=NULL,embedding_hash=NULL`).run(this.scopeId(scope), item.id, item.subjectId, item.subjectName, item.kind, item.text, normalize(item.text), JSON.stringify(item.tags), item.importance, item.confidence, item.status, item.origin, JSON.stringify(item.sourceRefs), JSON.stringify(item.supersedes), item.createdAt, item.updatedAt);
	}
	syncExplicit(scope, subjectId, notes) {
		if (notes.length > 20) throw new Error("明确记忆超过容量限制。");
		this.observe(scope);
		this.transaction(() => {
			const key = this.scopeId(scope);
			const existing = this.db.prepare("SELECT id,text FROM memories WHERE scope=? AND origin='explicit' AND subject_id=?").all(key, subjectId);
			const ids = new Set(notes.map((note) => note.id));
			if (!(existing.length !== notes.length || notes.some((note) => !existing.some((row) => row.id === note.id && row.text === note.text)))) return;
			this.db.prepare("UPDATE memory_scopes SET revision=revision+1 WHERE scope=?").run(key);
			for (const row of existing) if (!ids.has(String(row.id))) this.db.prepare("DELETE FROM memories WHERE scope=? AND id=?").run(key, row.id);
			for (const note of notes) this.insert(scope, {
				id: note.id,
				subjectId,
				subjectName: "",
				kind: "fact",
				text: note.text,
				tags: [],
				importance: 1,
				confidence: 1,
				origin: "explicit",
				status: "active",
				sourceRefs: [],
				supersedes: [],
				createdAt: note.createdAt,
				updatedAt: note.createdAt,
				lastRecalledAt: 0,
				recallDays: 0
			});
		});
	}
	activeDocuments(scope) {
		return this.db.prepare("SELECT * FROM memories WHERE scope=? AND status='active'").all(this.scopeId(scope)).map((row) => ({
			...this.decode(row),
			...row.embedding instanceof Uint8Array ? { embedding: Buffer.from(row.embedding) } : {},
			embeddingModel: row.embedding_model ? String(row.embedding_model) : void 0,
			embeddingHash: row.embedding_hash ? String(row.embedding_hash) : void 0
		}));
	}
	finishRanked(scope, ranked, limit, record) {
		const key = this.scopeId(scope);
		const unique = /* @__PURE__ */ new Set();
		const hits = [];
		const maximum = Math.trunc(Math.max(1, Math.min(20, limit))) || 0;
		if (maximum && ranked.length) {
			const current = this.db.prepare("SELECT * FROM memories WHERE scope=? AND id=? AND status='active'");
			for (const hit of ranked) {
				const identity = `${hit.subjectId}:${normalize(hit.text)}`;
				if (unique.has(identity)) continue;
				const row = current.get(key, hit.id);
				if (row?.text !== hit.text) continue;
				unique.add(identity);
				hits.push({
					...this.decode(row),
					score: hit.score
				});
				if (hits.length >= maximum) break;
			}
		}
		if (record && hits.length) {
			const now = this.now();
			const day = new Date(now).toISOString().slice(0, 10);
			this.transaction(() => {
				for (const item of hits) this.db.prepare(`UPDATE memories SET last_recalled_at=?, recall_days=recall_days+CASE WHEN recall_day<>? THEN 1 ELSE 0 END,recall_day=?
            WHERE scope=? AND id=?`).run(now, day, day, key, item.id);
				this.db.prepare("INSERT INTO memory_recalls(scope,at,ids) VALUES(?,?,?)").run(key, now, JSON.stringify(hits.map((item) => item.id)));
				this.db.prepare("DELETE FROM memory_recalls WHERE scope=? AND seq NOT IN(SELECT seq FROM memory_recalls WHERE scope=? ORDER BY seq DESC LIMIT 20)").run(key, key);
			});
		}
		return hits;
	}
	recall(scope, query, subjectId, limit = 8, record = true) {
		const documents = this.activeDocuments(scope);
		return this.finishRanked(scope, rankMemories(documents, query, subjectId, this.now()), limit, record);
	}
	/**
	* 可选语义召回：BM25 仍负责词面命中，embedding 只把“意思相近但用词不同”的
	* 条目补进候选。向量按模型与文本哈希缓存在本地；服务失败时退回 BM25。
	*/
	async recallSemantic(scope, query, subjectId, limit = 8, options, record = true) {
		const documents = this.activeDocuments(scope);
		const guard = this.state(scope);
		if (!documents.length || !query.trim()) return this.finishRanked(scope, rankMemories(documents, query, subjectId, this.now()), limit, record);
		const lexical = rankMemories(documents, query, subjectId, this.now());
		const candidates = /* @__PURE__ */ new Map();
		const cached = (item) => Boolean(item.embedding && item.embeddingModel === options.client.model && item.embeddingHash === hash(item.text) && item.embedding.length % 4 === 0);
		for (const item of documents.filter(cached)) candidates.set(item.id, item);
		const pending = [
			...lexical,
			...documents.filter((item) => item.subjectId === subjectId),
			...documents
		];
		let remaining = options.maxItems;
		for (const item of pending) {
			if (candidates.has(item.id) || cached(item) || remaining <= 0) continue;
			candidates.set(item.id, item);
			remaining--;
		}
		const selected = [...candidates.values()];
		const vectors = /* @__PURE__ */ new Map();
		const missing = [];
		for (const item of selected) if (item.embedding && item.embeddingModel === options.client.model && item.embeddingHash === hash(item.text) && item.embedding.length % 4 === 0) vectors.set(item.id, new Float32Array(item.embedding.buffer.slice(item.embedding.byteOffset, item.embedding.byteOffset + item.embedding.byteLength)));
		else missing.push(item);
		try {
			options.signal.throwIfAborted();
			const embedded = await options.client.embed([query, ...missing.map((item) => item.text)], AbortSignal.any([options.signal, AbortSignal.timeout(8e3)]));
			options.signal.throwIfAborted();
			const current = this.state(scope);
			if (guard?.epoch !== current?.epoch || guard?.revision !== current?.revision) return this.recall(scope, query, subjectId, limit, record);
			const queryVector = embedded[0];
			missing.forEach((item, index) => {
				const vector = embedded[index + 1];
				if (vector) vectors.set(item.id, vector);
			});
			if (missing.length && vectors.size === selected.length) this.transaction(() => {
				const statement = this.db.prepare("UPDATE memories SET embedding=?,embedding_model=?,embedding_hash=? WHERE scope=? AND id=? AND status='active'");
				const key = this.scopeId(scope);
				for (const item of missing) {
					const vector = vectors.get(item.id);
					if (vector) statement.run(Buffer.from(vector.buffer), options.client.model, hash(item.text), key, item.id);
				}
			});
			const hybrid = rankMemoriesHybrid(documents, lexical, queryVector, vectors, subjectId, options.weight, this.now());
			return this.finishRanked(scope, hybrid, limit, record);
		} catch (error) {
			if (options.signal.aborted) throw error;
			return this.finishRanked(scope, lexical, limit, record);
		}
	}
	profile(scope, subjectId, maxChars = 600) {
		const facts = this.list(scope, {
			status: "active",
			subjectId,
			limit: 2e3
		}).filter((item) => item.kind === "fact" && item.confidence >= .8).sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
		const selected = [];
		let length = 0;
		for (const fact of facts) {
			if (selected.some((item) => normalize(item.text) === normalize(fact.text))) continue;
			if (length + fact.text.length > maxChars) continue;
			selected.push(fact);
			length += fact.text.length;
			if (selected.length === 8) break;
		}
		return {
			facts: selected,
			text: selected.map((item) => item.text).join("；")
		};
	}
	recalls(scope) {
		return this.db.prepare("SELECT at,ids FROM memory_recalls WHERE scope=? ORDER BY seq DESC LIMIT 20").all(this.scopeId(scope)).map((row) => ({
			at: Number(row.at),
			ids: JSON.parse(String(row.ids))
		}));
	}
	applyExtraction(scope, guard, changes, sources, checkpoint, hasMore) {
		return this.transaction(() => {
			const state = this.state(scope);
			if (state?.epoch !== guard.epoch || state?.revision !== guard.revision || guard.checkpoint !== void 0 && state.checkpoint !== guard.checkpoint) return {
				applied: false,
				added: 0
			};
			const allowed = new Map(sources.map((source) => [source.seq, source]));
			const key = this.scopeId(scope);
			let added = 0;
			for (const change of changes) {
				if (!Number.isFinite(change.confidence) || change.confidence < 0 || change.confidence > 1 || !Number.isFinite(change.importance) || change.importance < 0 || change.importance > 1 || ![
					"add",
					"merge",
					"replace"
				].includes(change.action) || change.action === "add" && Boolean(change.targetId) || ![
					"fact",
					"insight",
					"style"
				].includes(change.kind) || !Array.isArray(change.tags) || change.tags.length > 5 || change.tags.some((tag) => typeof tag !== "string" || tag.length > 20)) throw new Error("记忆变更属性无效。");
				if (change.confidence < .8) continue;
				const refs = change.sourceSeqs.map((seq) => allowed.get(seq));
				if (!refs.length || refs.some((ref) => !ref) || new Set(refs.map((ref) => ref.speakerId)).size !== 1 || !refs[0]?.speakerId || !refs.some((ref) => ref.text.includes(change.evidence)) || !change.evidence.trim() || /假设|假装|开玩笑|只是玩笑|如果我是/u.test(change.evidence)) throw new Error("记忆来源或证据无效。");
				const subjectId = refs[0].speakerId;
				const old = change.targetId ? this.get(scope, change.targetId) : void 0;
				if (change.action !== "add" && (old?.subjectId !== subjectId || old?.status !== "active" || old?.origin === "explicit")) throw new Error("记忆变更目标无效，明确保存的资料需要用户手动更正。");
				const text = change.action === "merge" ? `${old.text}；${change.text}` : change.text;
				if (text.length > 800 || !text.trim()) throw new Error("记忆内容过长或为空。");
				if (this.db.prepare("SELECT id FROM memories WHERE scope=? AND subject_id=? AND normalized=? AND status='active'").get(key, subjectId, normalize(text))) continue;
				const capacity = scope.channelId.startsWith("private:") ? 1980 : 2e3;
				const count = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit' AND status='active'").get(key);
				const total = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit'").get(key);
				if (Number(total.n) >= 1e4) throw new Error("当前会话记忆及历史版本总容量已满，请先整理资料。");
				if (!old && Number(count.n) >= capacity) throw new Error("当前会话记忆容量已满。");
				if (old) this.db.prepare("UPDATE memories SET status='outdated' WHERE scope=? AND id=?").run(key, old.id);
				this.insert(scope, {
					id: randomUUID().replaceAll("-", "").slice(0, 12),
					subjectId,
					subjectName: refs[0].speaker,
					kind: change.kind,
					text,
					tags: change.tags,
					importance: change.importance,
					confidence: change.confidence,
					status: "active",
					origin: "extracted",
					sourceRefs: change.action === "merge" ? [...old.sourceRefs, ...refs].slice(-20) : refs,
					supersedes: old ? [old.id] : [],
					createdAt: this.now(),
					updatedAt: this.now(),
					lastRecalledAt: 0,
					recallDays: 0
				});
				added++;
			}
			this.db.prepare("UPDATE memory_scopes SET checkpoint=?,last_run=?,retry_after=? WHERE scope=?").run(Math.max(state.checkpoint, checkpoint), hasMore ? state.lastRun : this.now(), hasMore ? this.now() + 3e5 : 0, key);
			return {
				applied: true,
				added
			};
		});
	}
	failed(scope, guard) {
		this.db.prepare("UPDATE memory_scopes SET retry_after=? WHERE scope=? AND epoch=? AND revision=? AND (?=-1 OR checkpoint=?)").run(this.now() + 18e5, this.scopeId(scope), guard.epoch, guard.revision, guard.checkpoint ?? -1, guard.checkpoint ?? -1);
	}
	trace(scope, id, limit = 10) {
		const target = this.get(scope, id);
		if (!target) return {
			ok: false,
			message: "当前会话没有找到该记忆。"
		};
		const all = this.list(scope, {
			subjectId: target.subjectId,
			limit: 10020
		});
		const sources = new Set(target.sourceRefs.map((source) => source.seq));
		const links = all.filter((item) => item.id !== id).map((item) => {
			return {
				item,
				relation: target.origin === "diary" && item.origin === "event" && target.tags.includes(`reading:${item.id}`) ? "reading_source" : item.origin === "diary" && target.origin === "event" && item.tags.includes(`reading:${target.id}`) ? "reading_reflection" : target.supersedes.includes(item.id) ? "previous_version" : item.supersedes.includes(id) ? "next_version" : item.sourceRefs.some((source) => sources.has(source.seq)) ? "shared_evidence" : item.tags.some((tag) => target.tags.includes(tag)) ? "possibly_related" : void 0
			};
		}).filter((entry) => entry.relation);
		const priority = [
			"reading_source",
			"reading_reflection",
			"previous_version",
			"next_version",
			"shared_evidence",
			"possibly_related"
		];
		links.sort((a, b) => priority.indexOf(a.relation) - priority.indexOf(b.relation) || b.item.updatedAt - a.item.updatedAt);
		const selected = links.slice(0, Math.max(1, Math.min(20, limit)));
		return {
			ok: true,
			id,
			total: links.length,
			truncated: links.length > selected.length,
			links: selected.map(({ item, relation }) => ({
				id: item.id,
				relation,
				text: item.text.slice(0, 400),
				status: item.status,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				sourceSeqs: item.sourceRefs.map((source) => source.seq),
				sharedTags: relation === "possibly_related" ? item.tags.filter((tag) => target.tags.includes(tag)) : []
			})),
			notice: "仅限当前会话同一人物。标签相同只表示可能相关，不证明同一事件或因果；可继续用节点 ID 查询关联，用来源工具核实原文。"
		};
	}
	forget(scope, id, skipThrough) {
		return this.transaction(() => {
			const key = this.scopeId(scope);
			const all = this.list(scope, { limit: 10020 });
			const target = all.find((item) => item.id === id);
			if (!target) return false;
			const removed = connectedMemoryIds(all, target, true);
			for (const item of all) {
				if (item.subjectId !== target.subjectId || item.origin !== "diary") continue;
				if (item.tags.some((tag) => tag.startsWith("reading:") && removed.has(tag.slice(8)))) removed.add(item.id);
			}
			this.db.prepare("DELETE FROM shared_threads WHERE scope=? AND subject_id=?").run(key, target.subjectId);
			this.suppressFallback(scope, target.subjectId, skipThrough);
			for (const entryId of removed) this.db.prepare("DELETE FROM memories WHERE scope=? AND id=?").run(key, entryId);
			this.db.prepare("DELETE FROM memory_recalls WHERE scope=?").run(key);
			this.db.prepare("UPDATE memory_scopes SET revision=revision+1,checkpoint=max(checkpoint,?) WHERE scope=?").run(skipThrough, key);
			return true;
		});
	}
	clear(scope, skipThrough) {
		this.observe(scope);
		this.transaction(() => {
			const key = this.scopeId(scope);
			this.suppressFallback(scope, "", skipThrough);
			this.db.prepare("DELETE FROM memories WHERE scope=?").run(key);
			this.db.prepare("DELETE FROM shared_threads WHERE scope=?").run(key);
			this.db.prepare("DELETE FROM shared_checkpoints WHERE scope=?").run(key);
			this.db.prepare("DELETE FROM memory_recalls WHERE scope=?").run(key);
			this.db.prepare("UPDATE memory_scopes SET revision=revision+1,checkpoint=max(checkpoint,?) WHERE scope=?").run(skipThrough, key);
		});
	}
	restore(scope, id) {
		return this.transaction(() => {
			const key = this.scopeId(scope);
			const all = this.list(scope, { limit: 10020 });
			const item = all.find((entry) => entry.id === id && entry.status === "outdated");
			if (!item) return false;
			const connected = connectedMemoryIds(all, item, false);
			const current = all.filter((entry) => entry.status === "active" && connected.has(entry.id));
			const capacity = scope.channelId.startsWith("private:") ? 1980 : 2e3;
			const active = this.db.prepare("SELECT count(*) AS n FROM memories WHERE scope=? AND origin<>'explicit' AND status='active'").get(key);
			if (item.origin !== "explicit" && !current.length && Number(active.n) >= capacity) throw new Error("有效记忆容量已满，无法恢复额外条目。");
			for (const entry of current) this.db.prepare("UPDATE memories SET status='outdated' WHERE scope=? AND id=?").run(key, entry.id);
			this.db.prepare("UPDATE memories SET status='active',updated_at=? WHERE scope=? AND id=?").run(this.now(), key, id);
			this.db.prepare("UPDATE memory_scopes SET revision=revision+1 WHERE scope=?").run(key);
			return true;
		});
	}
	purgeHash(groupHash) {
		this.transaction(() => {
			const scopes = `SELECT scope FROM memory_scopes WHERE group_hash=? AND ${this.namespaceCondition}`;
			this.db.prepare(`DELETE FROM shared_threads WHERE scope IN (${scopes})`).run(groupHash, ...this.namespaceArgs);
			this.db.prepare(`DELETE FROM shared_checkpoints WHERE scope IN (${scopes})`).run(groupHash, ...this.namespaceArgs);
			this.db.prepare(`DELETE FROM memory_scopes WHERE group_hash=? AND ${this.namespaceCondition}`).run(groupHash, ...this.namespaceArgs);
		});
	}
	cleanup(days = 30) {
		const scopes = `SELECT scope FROM memory_scopes WHERE ${this.namespaceCondition}`;
		this.db.prepare(`DELETE FROM shared_threads WHERE updated_at<? AND scope IN (${scopes})`).run(this.now() - days * 864e5, ...this.namespaceArgs);
		this.db.prepare(`DELETE FROM memory_scopes WHERE active_at<? AND ${this.namespaceCondition}`).run(this.now() - days * 864e5, ...this.namespaceArgs);
	}
};
const processState = globalThis;
const stores = processState.__agentLinkMemories__ ??= /* @__PURE__ */ new Map();
const getMemoryStore = (config) => {
	const path = join(config.workspaceRoot ? dirname(config.workspaceRoot) : dirname(config.dshHomeRoot), "memories.sqlite");
	const namespace = conversationDataNamespace(config);
	const cacheKey = JSON.stringify([path, namespace]);
	let store = stores.get(cacheKey);
	if (!store) {
		store = new MemoryStore(path, Date.now, namespace);
		stores.set(cacheKey, store);
	}
	return store;
};

export { MemoryStore, experienceMemoryId, getMemoryStore, normalize as memoryTextKey };