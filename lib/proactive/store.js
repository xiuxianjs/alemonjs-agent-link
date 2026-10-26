import { interruptProactive, proactiveChannel, proactiveScopeId } from "./control.js";
import { isQuiet, localDay } from "./options.js";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// src/proactive/store.ts
const hash = (text) => createHash("sha256").update(text).digest("hex");
const question = (text) => /[？?]|(?:吗|呢|嘛)[。！!\s]*$/u.test(text.trim());
const interval = (now, options, random) => now + Math.round((options.minIntervalMinutes + Math.max(0, Math.min(1, random())) * (options.maxIntervalMinutes - options.minIntervalMinutes)) * 6e4);
var ProactiveStore = class {
	root;
	now;
	random;
	db;
	constructor(root, now = Date.now, random = Math.random) {
		this.root = root;
		this.now = now;
		this.random = random;
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "proactive.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS proactive_subscriptions(id TEXT PRIMARY KEY,platform TEXT NOT NULL,botId TEXT NOT NULL,userId TEXT NOT NULL,
        channelHash TEXT NOT NULL,enabled INTEGER NOT NULL,pausedUntil INTEGER NOT NULL,revision INTEGER NOT NULL,
        lastInputAt INTEGER NOT NULL,lastOutputAt INTEGER NOT NULL,questionId TEXT NOT NULL,questionText TEXT NOT NULL,questionAt INTEGER NOT NULL,
        nudgedFor TEXT NOT NULL,unanswered INTEGER NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,nudges INTEGER NOT NULL,nextAt INTEGER NOT NULL,
        pendingId TEXT NOT NULL,leaseUntil INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS proactive_attempts(id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,at INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS proactive_attempt_scope ON proactive_attempts(scope,at);
      CREATE TABLE IF NOT EXISTS proactive_inputs(scope TEXT NOT NULL,message_hash TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,message_hash));`);
	}
	close() {
		this.db.close();
	}
	get(scope) {
		const row = this.db.prepare("SELECT * FROM proactive_subscriptions WHERE id=?").get(proactiveScopeId(scope));
		return row ? {
			...row,
			enabled: Boolean(row.enabled)
		} : void 0;
	}
	list() {
		return this.db.prepare("SELECT * FROM proactive_subscriptions WHERE enabled=1 ORDER BY nextAt LIMIT 100").all().map((row) => ({
			...row,
			enabled: Boolean(row.enabled)
		}));
	}
	due(scope, options, manual = false) {
		const row = this.get(scope);
		const now = this.now();
		if (!row?.enabled || !options.enabled || row.pendingId && row.leaseUntil > now || row.unanswered >= options.maxUnanswered || !manual && (row.pausedUntil > now || isQuiet(now, options))) return false;
		const sameDay = row.day === localDay(now, options.timezone);
		const elapsed = now - row.questionAt;
		const nudge = !manual && options.nudge && row.questionId && row.nudgedFor !== row.questionId && elapsed >= options.nudgeMinMinutes * 6e4 && elapsed < options.nudgeMaxMinutes * 6e4 && (sameDay ? row.nudges : 0) < options.maxNudgesPerDay;
		return Boolean(nudge || (sameDay ? row.count : 0) < options.maxPerDay && (manual || now >= row.nextAt && now - Math.max(row.lastInputAt, row.lastOutputAt) >= options.idleMinutes * 6e4));
	}
	recover() {
		for (const row of this.db.prepare("SELECT * FROM proactive_subscriptions WHERE pendingId!='' AND leaseUntil<=?").all(this.now())) {
			this.db.exec("BEGIN IMMEDIATE");
			try {
				const attempt = this.db.prepare("SELECT status FROM proactive_attempts WHERE id=?").get(row.pendingId);
				const unknown = attempt && ["sending", "unknown"].includes(String(attempt.status));
				this.db.prepare("UPDATE proactive_attempts SET status=?,updatedAt=? WHERE id=? AND status IN ('generating','sending')").run(unknown ? "unknown" : "failed", this.now(), row.pendingId);
				this.db.prepare("UPDATE proactive_subscriptions SET pendingId='',leaseUntil=0,pausedUntil=? WHERE id=? AND pendingId=? AND leaseUntil<=?").run(unknown ? Number.MAX_SAFE_INTEGER : row.pausedUntil, row.id, row.pendingId, this.now());
				this.db.exec("COMMIT");
			} catch (error) {
				this.db.exec("ROLLBACK");
				throw error;
			}
		}
	}
	subscribe(scope, enabled, options) {
		this.validate(scope);
		const previous = this.get(scope);
		if (!previous && Number(this.db.prepare("SELECT COUNT(*) AS n FROM proactive_subscriptions").get().n) >= 100) throw new Error("主动搭话订阅数量已满。");
		interruptProactive(this.root, scope);
		if (previous) this.db.prepare(`UPDATE proactive_subscriptions SET enabled=?,pausedUntil=0,revision=revision+1,lastInputAt=?,unanswered=0,questionId='',questionText='',questionAt=0,nudgedFor='',nextAt=?,updatedAt=? WHERE id=?`).run(enabled ? 1 : 0, this.now(), interval(this.now(), options, this.random), this.now(), previous.id);
		else this.db.prepare("INSERT INTO proactive_subscriptions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(proactiveScopeId(scope), scope.platform, scope.botId, scope.userId, hash(proactiveChannel(scope)), enabled ? 1 : 0, 0, 1, this.now(), 0, "", "", 0, "", 0, localDay(this.now(), options.timezone), 0, 0, interval(this.now(), options, this.random), "", 0, this.now());
	}
	pause(scope, minutes) {
		if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 10080) throw new Error("暂停时间无效。");
		interruptProactive(this.root, scope);
		this.db.prepare("UPDATE proactive_subscriptions SET pausedUntil=?,revision=revision+1,updatedAt=? WHERE id=?").run(minutes ? this.now() + minutes * 6e4 : 0, this.now(), proactiveScopeId(scope));
	}
	input(scope, messageId) {
		if (!messageId || !this.get(scope)) return false;
		const id = proactiveScopeId(scope);
		const result = this.db.prepare("INSERT OR IGNORE INTO proactive_inputs VALUES(?,?,?)").run(id, hash(messageId), this.now());
		if (!Number(result.changes)) return false;
		interruptProactive(this.root, scope);
		this.db.prepare("UPDATE proactive_subscriptions SET lastInputAt=?,revision=revision+1,unanswered=0,questionId='',questionText='',questionAt=0,nudgedFor='',updatedAt=? WHERE id=?").run(this.now(), this.now(), id);
		this.db.prepare("DELETE FROM proactive_inputs WHERE scope=? AND message_hash NOT IN (SELECT message_hash FROM proactive_inputs WHERE scope=? ORDER BY at DESC,rowid DESC LIMIT 256)").run(id, id);
		return true;
	}
	output(scope, messageId, text) {
		if (!this.get(scope)) return;
		interruptProactive(this.root, scope);
		const asking = question(text);
		this.db.prepare("UPDATE proactive_subscriptions SET lastOutputAt=?,revision=revision+1,questionId=?,questionText=?,questionAt=?,nudgedFor='',updatedAt=? WHERE id=?").run(this.now(), asking ? hash(messageId) : "", asking ? text.slice(-256) : "", asking ? this.now() : 0, this.now(), proactiveScopeId(scope));
	}
	claim(scope, options, leaseMs, manual = false) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.get(scope);
			const now = this.now();
			if (!row || !row.enabled || !options.enabled) {
				this.db.exec("COMMIT");
				return;
			}
			if (row.pendingId) {
				if (row.leaseUntil > now) {
					this.db.exec("COMMIT");
					return;
				}
				this.db.prepare("UPDATE proactive_attempts SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'failed' END,updatedAt=? WHERE id=? AND status IN ('generating','sending')").run(now, row.pendingId);
				if (this.db.prepare("SELECT status FROM proactive_attempts WHERE id=?").get(row.pendingId)?.status === "unknown") {
					row.pausedUntil = Number.MAX_SAFE_INTEGER;
					this.db.prepare("UPDATE proactive_subscriptions SET pausedUntil=? WHERE id=?").run(row.pausedUntil, row.id);
				}
				this.db.prepare("UPDATE proactive_subscriptions SET pendingId='',leaseUntil=0 WHERE id=?").run(row.id);
			}
			const today = localDay(now, options.timezone);
			const count = row.day === today ? row.count : 0;
			const nudges = row.day === today ? row.nudges : 0;
			if (!manual && (row.pausedUntil > now || isQuiet(now, options)) || row.unanswered >= options.maxUnanswered) {
				this.db.exec("COMMIT");
				return;
			}
			const silence = now - row.questionAt;
			let kind = "initial";
			if (!manual && options.nudge && row.questionId && row.nudgedFor !== row.questionId && silence >= options.nudgeMinMinutes * 6e4 && silence < options.nudgeMaxMinutes * 6e4 && nudges < options.maxNudgesPerDay) {
				this.db.prepare("UPDATE proactive_subscriptions SET nudgedFor=? WHERE id=?").run(row.questionId, row.id);
				if (this.random() >= options.nudgeChance) {
					this.db.exec("COMMIT");
					return;
				}
				kind = "nudge";
			} else if (count >= options.maxPerDay || !manual && (now < row.nextAt || now - Math.max(row.lastInputAt, row.lastOutputAt) < options.idleMinutes * 6e4)) {
				this.db.exec("COMMIT");
				return;
			}
			const id = randomUUID();
			this.db.prepare("INSERT INTO proactive_attempts VALUES(?,?,?,?,?,?)").run(id, row.id, kind, "generating", now, now);
			this.db.prepare("UPDATE proactive_subscriptions SET pendingId=?,leaseUntil=?,day=?,count=?,nudges=?,nextAt=?,updatedAt=? WHERE id=?").run(id, now + leaseMs, today, count + (kind === "initial" ? 1 : 0), nudges + (kind === "nudge" ? 1 : 0), interval(now, options, this.random), now, row.id);
			this.db.exec("COMMIT");
			return {
				id,
				scope,
				revision: row.revision,
				kind,
				questionText: row.questionText
			};
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	current(attempt, options, manual = false) {
		const row = this.get(attempt.scope);
		return Boolean(row?.enabled && row.revision === attempt.revision && row.pendingId === attempt.id && options.enabled && (manual || row.pausedUntil <= this.now() && !isQuiet(this.now(), options)));
	}
	sending(attempt, options, manual = false) {
		if (!this.current(attempt, options, manual)) return false;
		const change = this.db.prepare("UPDATE proactive_attempts SET status='sending',updatedAt=? WHERE id=? AND status='generating'").run(this.now(), attempt.id);
		if (Number(change.changes)) this.db.prepare("UPDATE proactive_subscriptions SET unanswered=unanswered+1 WHERE id=? AND pendingId=?").run(proactiveScopeId(attempt.scope), attempt.id);
		return true;
	}
	finish(attempt, result, text = "") {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const existing = this.db.prepare("SELECT status FROM proactive_attempts WHERE id=?").get(attempt.id);
			if (!existing || !["generating", "sending"].includes(String(existing.status))) {
				this.db.exec("COMMIT");
				return existing ? String(existing.status) : result;
			}
			if (existing.status === "sending" && ["failed", "cancelled"].includes(result)) result = "unknown";
			this.db.prepare("UPDATE proactive_attempts SET status=?,updatedAt=? WHERE id=?").run(result, this.now(), attempt.id);
			const row = this.get(attempt.scope);
			if (row?.pendingId === attempt.id) {
				if (result === "unknown") this.db.prepare("UPDATE proactive_subscriptions SET pausedUntil=? WHERE id=?").run(Number.MAX_SAFE_INTEGER, row.id);
				if (result === "confirmed") {
					this.db.prepare("UPDATE proactive_subscriptions SET lastOutputAt=? WHERE id=?").run(this.now(), row.id);
					if (attempt.kind === "initial" && row.revision === attempt.revision && question(text)) this.db.prepare("UPDATE proactive_subscriptions SET questionId=?,questionText=?,questionAt=?,nudgedFor='' WHERE id=?").run(attempt.id, text.slice(-256), this.now(), row.id);
				}
				this.db.prepare("UPDATE proactive_subscriptions SET pendingId='',leaseUntil=0,updatedAt=? WHERE id=?").run(this.now(), row.id);
			}
			this.db.prepare("DELETE FROM proactive_attempts WHERE scope=? AND id NOT IN (SELECT id FROM proactive_attempts WHERE scope=? ORDER BY at DESC,rowid DESC LIMIT 50)").run(proactiveScopeId(attempt.scope), proactiveScopeId(attempt.scope));
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	attempts(scope) {
		return this.db.prepare("SELECT kind,status,at FROM proactive_attempts WHERE scope=? ORDER BY at DESC,rowid DESC LIMIT 5").all(proactiveScopeId(scope));
	}
	purgeHash(channelHash) {
		const rows = this.db.prepare("SELECT id,platform,botId,userId FROM proactive_subscriptions WHERE channelHash=?").all(channelHash);
		for (const row of rows) this.remove(row);
	}
	cleanup(days) {
		for (const row of this.db.prepare("SELECT * FROM proactive_subscriptions WHERE lastInputAt<?").all(this.now() - days * 864e5)) this.remove(row);
		this.db.prepare("DELETE FROM proactive_attempts WHERE at<?").run(this.now() - days * 864e5);
	}
	remove(row) {
		interruptProactive(this.root, row);
		this.db.prepare("DELETE FROM proactive_subscriptions WHERE id=?").run(row.id);
		this.db.prepare("DELETE FROM proactive_attempts WHERE scope=?").run(row.id);
		this.db.prepare("DELETE FROM proactive_inputs WHERE scope=?").run(row.id);
	}
	validate(scope) {
		if (!["onebot", "qq-bot"].includes(scope.platform) || !scope.botId || !scope.userId || scope.botId.length > 200 || scope.userId.length > 200) throw new Error("主动搭话缺少明确的平台、账号或私聊对象。");
	}
};
const state = globalThis;
const stores = state.__agentLinkProactiveStores__ ??= /* @__PURE__ */ new Map();
const getProactiveStore = (config) => {
	const root = dirname(config.workspaceRoot);
	let store = stores.get(root);
	if (!store) {
		store = new ProactiveStore(root);
		stores.set(root, store);
	}
	return store;
};

export { ProactiveStore, getProactiveStore };