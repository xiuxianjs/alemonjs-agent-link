import { builtinQaEntries } from "./builtin.js";
import { normalizeQaText } from "./detection.js";
import { rankQa } from "./retrieval.js";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// src/qa/store.ts
const globalScope = "global";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const scopeKey = (scope) => {
	if (!scope.platform || !scope.channelId) throw new Error("问答库缺少平台或会话标识。");
	return hash(JSON.stringify([scope.platform, scope.channelId]));
};
const cleanText = (value) => String(value ?? "").trim();
const validateEntry = (input) => {
	const question = cleanText(input.question);
	const answer = cleanText(input.answer);
	const normalized = normalizeQaText(question);
	const keywords = (input.keywords || []).map(cleanText).filter(Boolean);
	const tags = (input.tags || []).map(cleanText).filter(Boolean);
	if (question.length < 2 || question.length > 300 || !normalized) throw new Error("问答的问题需为 2-300 字。");
	if (answer.length < 1 || answer.length > 1200) throw new Error("问答的答案需为 1-1200 字。");
	if (keywords.length > 10 || keywords.some((keyword) => keyword.length > 30)) throw new Error("问答关键词最多 10 个，每个不超过 30 字。");
	if (tags.length > 5 || tags.some((tag) => tag.length > 20)) throw new Error("问答标签最多 5 个，每个不超过 20 字。");
	const kind = input.kind ?? "general";
	if (![
		"why",
		"command",
		"general"
	].includes(kind)) throw new Error("问答类型无效。");
	return {
		question,
		answer,
		normalized,
		keywords,
		tags,
		kind
	};
};
var QAStore = class {
	now;
	db;
	constructor(path, now = Date.now) {
		this.now = now;
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS qa_removed_builtins (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS qa_scopes (
        scope TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
        group_hash TEXT NOT NULL, active_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS qa_entries (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, question TEXT NOT NULL, normalized_question TEXT NOT NULL,
        answer TEXT NOT NULL, keywords TEXT NOT NULL, tags TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'general', origin TEXT NOT NULL,
        confidence REAL NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS qa_entry_scope_question ON qa_entries(scope, normalized_question);
      CREATE INDEX IF NOT EXISTS qa_entry_scope ON qa_entries(scope);
      CREATE TABLE IF NOT EXISTS qa_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, user_id TEXT NOT NULL,
        question TEXT NOT NULL, matched_id TEXT, answer TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS qa_question_scope ON qa_questions(scope, id);`);
		if (!new Set(this.db.prepare("PRAGMA table_info(qa_entries)").all().map((row) => String(row.name))).has("kind")) this.db.exec("ALTER TABLE qa_entries ADD COLUMN kind TEXT NOT NULL DEFAULT 'general'");
		this.seedBuiltins();
	}
	close() {
		this.db.close();
	}
	transaction(run) {
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
	seedBuiltins() {
		const insert = this.db.prepare(`INSERT OR IGNORE INTO qa_entries
      (id,scope,question,normalized_question,answer,keywords,tags,kind,origin,confidence,hits,last_hit_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,'builtin',1,0,0,?,?)`);
		const update = this.db.prepare(`UPDATE qa_entries SET question=?,normalized_question=?,answer=?,keywords=?,tags=?,kind=?,updated_at=?
      WHERE id=? AND origin='builtin'`);
		const conflict = this.db.prepare("SELECT id FROM qa_entries WHERE scope='global' AND normalized_question=? AND id<>?");
		const at = this.now();
		this.transaction(() => {
			for (const entry of builtinQaEntries) {
				if (this.db.prepare("SELECT id FROM qa_removed_builtins WHERE id=?").get(entry.id)) continue;
				const normalized = normalizeQaText(entry.question);
				insert.run(entry.id, globalScope, entry.question, normalized, entry.answer, JSON.stringify(entry.keywords), JSON.stringify(entry.tags), entry.kind, at, at);
				if (!conflict.get(normalized, entry.id)) update.run(entry.question, normalized, entry.answer, JSON.stringify(entry.keywords), JSON.stringify(entry.tags), entry.kind, at, entry.id);
			}
		});
	}
	decode(row) {
		return {
			id: String(row.id),
			scope: String(row.scope),
			question: String(row.question),
			answer: String(row.answer),
			keywords: JSON.parse(String(row.keywords)),
			tags: JSON.parse(String(row.tags)),
			kind: row.kind || "general",
			origin: row.origin,
			confidence: Number(row.confidence),
			hits: Number(row.hits),
			lastHitAt: Number(row.last_hit_at),
			createdAt: Number(row.created_at),
			updatedAt: Number(row.updated_at)
		};
	}
	observe(scope) {
		const key = scopeKey(scope);
		this.db.prepare(`INSERT INTO qa_scopes(scope,platform,channel_id,group_hash,active_at) VALUES(?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET active_at=excluded.active_at`).run(key, scope.platform, scope.channelId, hash(scope.channelId), this.now());
	}
	search(scope, query, limit = 3, options = {}) {
		const key = scopeKey(scope);
		const entries = this.db.prepare("SELECT * FROM qa_entries WHERE scope='global' OR scope=?").all(key).map((row) => this.decode(row)).filter((entry) => !options.kind || entry.kind === "general" || entry.kind === options.kind);
		const ranked = rankQa(entries, query, {
			threshold: options.threshold,
			now: this.now()
		});
		const top = ranked[0]?.score ?? 0;
		const matches = ranked.filter((item, index) => index === 0 || item.score >= top * .8).slice(0, Math.max(1, Math.min(20, limit)));
		if (options.record !== false && matches.length) {
			const at = this.now();
			this.transaction(() => {
				const statement = this.db.prepare("UPDATE qa_entries SET hits=hits+1,last_hit_at=? WHERE id=?");
				for (const item of matches) statement.run(at, item.id);
			});
		}
		return matches;
	}
	list(scope, options = {}) {
		const key = scopeKey(scope);
		return (options.includeGlobal ? this.db.prepare("SELECT * FROM qa_entries WHERE scope='global' OR scope=? ORDER BY updated_at DESC LIMIT ?").all(key, Math.max(1, Math.min(200, options.limit ?? 50))) : this.db.prepare("SELECT * FROM qa_entries WHERE scope=? ORDER BY updated_at DESC LIMIT ?").all(key, Math.max(1, Math.min(200, options.limit ?? 50)))).map((row) => this.decode(row));
	}
	searchGlobal(query, limit = 10) {
		const entries = this.db.prepare("SELECT * FROM qa_entries WHERE scope='global'").all().map((row) => this.decode(row));
		return rankQa(entries, query, { now: this.now() }).slice(0, Math.max(1, Math.min(20, limit)));
	}
	listGlobal(limit = 100) {
		return this.db.prepare("SELECT * FROM qa_entries WHERE scope='global' ORDER BY updated_at DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))).map((row) => this.decode(row));
	}
	get(scope, id) {
		const row = this.db.prepare("SELECT * FROM qa_entries WHERE scope=? AND id=?").get(scopeKey(scope), id);
		return row ? this.decode(row) : void 0;
	}
	scopes() {
		return this.db.prepare("SELECT platform,channel_id AS channelId FROM qa_scopes ORDER BY active_at DESC").all().map((row) => ({
			platform: String(row.platform),
			channelId: String(row.channelId)
		}));
	}
	edit(target, id, updatedAt, input) {
		const key = target === "global" ? "global" : scopeKey(target);
		return this.transaction(() => {
			const row = this.db.prepare("SELECT * FROM qa_entries WHERE scope=? AND id=?").get(key, id);
			if (!row) throw new Error("问答不存在");
			if (Number(row.updated_at) !== updatedAt) throw new Error("配置已变化，请刷新后重试");
			if (!input) {
				if (builtinQaEntries.some((entry) => entry.id === id)) this.db.prepare("INSERT OR IGNORE INTO qa_removed_builtins(id) VALUES(?)").run(id);
				this.db.prepare("DELETE FROM qa_entries WHERE scope=? AND id=?").run(key, id);
				return;
			}
			const { question, answer, normalized, keywords, tags, kind } = validateEntry(input);
			if (this.db.prepare("SELECT id FROM qa_entries WHERE scope=? AND normalized_question=? AND id<>?").get(key, normalized, id)) throw new Error("同一范围已存在相同问题");
			this.db.prepare("UPDATE qa_entries SET question=?,normalized_question=?,answer=?,keywords=?,tags=?,kind=?,origin='explicit',confidence=1,updated_at=? WHERE scope=? AND id=?").run(question, normalized, answer, JSON.stringify(keywords), JSON.stringify(tags), kind, Math.max(this.now(), updatedAt + 1), key, id);
			return this.decode(this.db.prepare("SELECT * FROM qa_entries WHERE scope=? AND id=?").get(key, id));
		});
	}
	addExplicit(target, input) {
		const { question, answer, normalized, keywords, tags, kind } = validateEntry(input);
		const key = target === globalScope ? globalScope : scopeKey(target);
		if (target !== globalScope) this.observe(target);
		const at = this.now();
		const id = hash(JSON.stringify([
			"qa",
			key,
			normalized
		])).slice(0, 12);
		this.transaction(() => {
			this.db.prepare(`INSERT INTO qa_entries
          (id,scope,question,normalized_question,answer,keywords,tags,kind,origin,confidence,hits,last_hit_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'explicit',1,0,0,?,?)
          ON CONFLICT(scope,normalized_question) DO UPDATE SET
            answer=excluded.answer,keywords=excluded.keywords,tags=excluded.tags,kind=excluded.kind,
            origin='explicit',confidence=1,updated_at=excluded.updated_at`).run(id, key, question, normalized, answer, JSON.stringify(keywords), JSON.stringify(tags), kind, at, at);
		});
		const row = this.db.prepare("SELECT * FROM qa_entries WHERE scope=? AND normalized_question=?").get(key, normalized);
		return this.decode(row);
	}
	/**
	* 记录本轮未命中的“为什么”问答。答案来自已经送达的回复，因此可信度低于
	* 手动保存和内置条目；同一问题的重复提问只更新答案与时间，不重复占名额。
	*/
	learn(scope, input, maxEntries = 200) {
		const question = cleanText(input.question);
		const answer = cleanText(input.answer);
		const normalized = normalizeQaText(question);
		if (question.length < 4 || question.length > 300 || normalized.length < 4) return;
		if (answer.length < 6 || answer.length > 1200) return;
		if (/(糟糕，网线断了|非常抱歉，我网卡没流量了|服务暂时不可用|模型服务暂时不可用|请稍后再试|回复因内容安全策略未发送|\[沉默\])/u.test(answer)) return;
		if (/^(我不知道|我不清楚|我不确定|不清楚|不确定|无法回答|无法确定)/u.test(answer)) return;
		this.observe(scope);
		const key = scopeKey(scope);
		return this.transaction(() => {
			if (this.db.prepare("SELECT id FROM qa_entries WHERE scope='global' AND normalized_question=?").get(normalized)) return;
			const existing = this.db.prepare("SELECT * FROM qa_entries WHERE scope=? AND normalized_question=?").get(key, normalized);
			if (existing) {
				if (existing.origin === "explicit") return this.decode(existing);
				this.db.prepare("UPDATE qa_entries SET answer=?,confidence=MAX(confidence,0.65),updated_at=? WHERE id=?").run(answer, this.now(), String(existing.id));
				const updated = this.db.prepare("SELECT * FROM qa_entries WHERE id=?").get(String(existing.id));
				return updated ? this.decode(updated) : void 0;
			}
			const count = this.db.prepare("SELECT count(*) AS n FROM qa_entries WHERE scope=? AND origin='learned'").get(key);
			if (Number(count.n) >= maxEntries) return;
			const at = this.now();
			const id = hash(JSON.stringify([
				"qa",
				key,
				normalized
			])).slice(0, 12);
			this.db.prepare(`INSERT INTO qa_entries
          (id,scope,question,normalized_question,answer,keywords,tags,kind,origin,confidence,hits,last_hit_at,created_at,updated_at)
          VALUES(?,?,?,?,?,'[]','[]','general','learned',0.65,0,0,?,?)`).run(id, key, question, normalized, answer, at, at);
			return this.get(scope, id);
		});
	}
	recordAsked(scope, input) {
		const question = cleanText(input.question).slice(0, 300);
		const answer = cleanText(input.answer).slice(0, 1200);
		if (!question || !answer) return;
		this.observe(scope);
		const key = scopeKey(scope);
		this.transaction(() => {
			this.db.prepare("INSERT INTO qa_questions(scope,user_id,question,matched_id,answer,created_at) VALUES(?,?,?,?,?,?)").run(key, cleanText(input.userId).slice(0, 200), question, input.matchedId || null, answer, this.now());
			this.db.prepare(`DELETE FROM qa_questions WHERE scope=? AND id NOT IN
          (SELECT id FROM qa_questions WHERE scope=? ORDER BY id DESC LIMIT 200)`).run(key, key);
		});
	}
	recentQuestions(scope, limit = 20) {
		return this.db.prepare("SELECT * FROM qa_questions WHERE scope=? ORDER BY id DESC LIMIT ?").all(scopeKey(scope), Math.max(1, Math.min(100, limit))).map((row) => ({
			id: Number(row.id),
			question: String(row.question),
			answer: String(row.answer),
			...row.matched_id ? { matchedId: String(row.matched_id) } : {},
			userId: String(row.user_id),
			createdAt: Number(row.created_at)
		}));
	}
	purgeHash(groupHash) {
		this.transaction(() => {
			const scopes = this.db.prepare("SELECT scope FROM qa_scopes WHERE group_hash=?").all(groupHash).map((row) => String(row.scope));
			if (!scopes.length) return;
			const placeholders = scopes.map(() => "?").join(",");
			this.db.prepare(`DELETE FROM qa_entries WHERE scope IN (${placeholders})`).run(...scopes);
			this.db.prepare(`DELETE FROM qa_questions WHERE scope IN (${placeholders})`).run(...scopes);
			this.db.prepare("DELETE FROM qa_scopes WHERE group_hash=?").run(groupHash);
		});
	}
	cleanup(days = 30) {
		const cutoff = this.now() - days * 864e5;
		this.transaction(() => {
			this.db.prepare("DELETE FROM qa_entries WHERE scope<>'global' AND scope IN (SELECT scope FROM qa_scopes WHERE active_at<?)").run(cutoff);
			this.db.prepare("DELETE FROM qa_questions WHERE created_at<? OR scope IN (SELECT scope FROM qa_scopes WHERE active_at<?)").run(cutoff, cutoff);
			this.db.prepare("DELETE FROM qa_scopes WHERE active_at<?").run(cutoff);
		});
	}
};
const processState = globalThis;
const stores = processState.__agentLinkQa__ ??= /* @__PURE__ */ new Map();
const getQAStore = (config) => {
	const path = join(config.workspaceRoot ? dirname(config.workspaceRoot) : dirname(config.dshHomeRoot), "qa.sqlite");
	let store = stores.get(path);
	if (!store) {
		store = new QAStore(path);
		stores.set(path, store);
	}
	return store;
};

export { QAStore, getQAStore };