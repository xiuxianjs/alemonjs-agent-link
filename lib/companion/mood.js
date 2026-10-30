import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// src/companion/mood.ts
const moodOptions = (config) => {
	const raw = config.modules?.settings?.mood || {};
	const result = {
		baseline: raw.baseline ?? 60,
		halfLifeHours: raw.halfLifeHours ?? 6,
		modelJudge: raw.modelJudge ?? true
	};
	if (!Number.isFinite(result.baseline) || Number(result.baseline) < 20 || Number(result.baseline) > 80 || !Number.isFinite(result.halfLifeHours) || Number(result.halfLifeHours) < .1 || Number(result.halfLifeHours) > 168 || typeof result.modelJudge !== "boolean") throw new Error("mood 模块设置无效。");
	return {
		baseline: Number(result.baseline),
		halfLifeHours: Number(result.halfLifeHours),
		modelJudge: result.modelJudge
	};
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const key = (scope) => {
	if (!scope.platform || !scope.channelId) throw new Error("心情缺少会话标识。");
	return digest(JSON.stringify([scope.platform, scope.channelId]));
};
const bound = (value) => Math.max(0, Math.min(100, value));
const moodLabel = (value) => value >= 75 ? "愉快" : value >= 45 ? "平和" : value >= 25 ? "低落" : "疲惫";
const keywordMoodDelta = (text) => {
	if (text.length > 500 || /[“”「」<>]|不是|并不|没有|别说|不要说|他说|她说|有人说/u.test(text) || text.trimStart().startsWith("/")) return 0;
	const addressed = text.trim().replace(/^(?:大肥鱼|小肥鱼|肥鱼|小鲸鱼)[，,：:\s]*/u, "").replace(/[，,\s]*(?:大肥鱼|小肥鱼|肥鱼|小鲸鱼)[！!。\s]*$/u, "");
	if (/^(?:你(?:这个|真是|就是)?(?:笨蛋|废物|傻逼)|闭嘴|滚开)[！!。，,\s]*$/u.test(addressed)) return -6;
	if (/^(?:谢谢你|谢谢|你真棒|你太棒了|辛苦你了|喜欢你|你真可爱|谢谢你帮我|有你真好|抱抱你|抱抱)[！!。，,呀啊呢\s]*$/u.test(addressed)) return 4;
	if (/^(?:早上好|早安|晚安|晚上好|陪我聊聊天|一起喝茶吧)[！!。，,呀啊呢~～\s]*$/u.test(addressed)) return 1;
	return 0;
};
const parseMoodJudgment = (content) => {
	if (!content?.trim()) return { reason: "empty-content" };
	let parsed;
	try {
		parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, "$1"));
	} catch {
		return { reason: "invalid-json" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reason: "invalid-object" };
	const { delta, confidence } = parsed;
	if (typeof delta !== "number" || !Number.isInteger(delta) || Math.abs(delta) > 6) return { reason: "invalid-delta" };
	if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { reason: "invalid-confidence" };
	if (confidence < .8) return { reason: "low-confidence" };
	return { delta };
};
var MoodStore = class {
	now;
	db;
	constructor(root, now = Date.now) {
		this.now = now;
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "moods.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS moods(scope TEXT PRIMARY KEY,channel_hash TEXT NOT NULL,value REAL NOT NULL,at INTEGER NOT NULL,
        token TEXT NOT NULL,last_keyword_at INTEGER NOT NULL,keyword_delta REAL NOT NULL,model_done INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mood_inputs(scope TEXT NOT NULL,input_hash TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(scope,input_hash));
      CREATE TABLE IF NOT EXISTS mood_history(seq INTEGER PRIMARY KEY,scope TEXT NOT NULL,at INTEGER NOT NULL,value REAL NOT NULL,delta REAL NOT NULL,source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mood_history_scope ON mood_history(scope,seq);`);
	}
	close() {
		this.db.close();
	}
	value(row, options) {
		return row ? bound(options.baseline + (Number(row.value) - options.baseline) * 2 ** (-Math.max(0, this.now() - Number(row.at)) / (options.halfLifeHours * 36e5))) : options.baseline;
	}
	snapshot(scope, options, retentionDays = 30) {
		this.expire(key(scope), retentionDays);
		const row = this.db.prepare("SELECT * FROM moods WHERE scope=?").get(key(scope));
		const value = this.value(row, options);
		return {
			value,
			label: moodLabel(value),
			token: row ? String(row.token) : void 0
		};
	}
	observe(scope, inputId, delta, options, retentionDays = 30) {
		if (!inputId || !Number.isFinite(delta)) throw new Error("心情输入无效。");
		const scopeId = key(scope);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.expire(scopeId, retentionDays);
			const previous = this.db.prepare("SELECT * FROM moods WHERE scope=?").get(scopeId);
			const now = this.now();
			const seen = this.db.prepare("INSERT OR IGNORE INTO mood_inputs(scope,input_hash,at) VALUES(?,?,?)").run(scopeId, digest(inputId), now);
			const before = this.value(previous, options);
			if (!Number(seen.changes)) {
				this.db.exec("COMMIT");
				return {
					value: before,
					label: moodLabel(before)
				};
			}
			const applied = previous && now - Number(previous.last_keyword_at) < 1e4 ? 0 : Math.max(-6, Math.min(4, delta));
			const value = bound(before + applied);
			const token = randomUUID();
			this.db.prepare(`INSERT INTO moods VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(scope) DO UPDATE SET
        value=excluded.value,at=excluded.at,token=excluded.token,last_keyword_at=excluded.last_keyword_at,keyword_delta=excluded.keyword_delta,model_done=0`).run(scopeId, digest(scope.channelId), value, now, token, applied ? now : Number(previous?.last_keyword_at || 0), applied);
			if (applied) this.record(scopeId, value, value - before, "keyword");
			this.db.prepare("DELETE FROM mood_inputs WHERE scope=? AND input_hash NOT IN (SELECT input_hash FROM mood_inputs WHERE scope=? ORDER BY at DESC,rowid DESC LIMIT 256)").run(scopeId, scopeId);
			this.db.exec("COMMIT");
			return {
				value,
				label: moodLabel(value),
				token
			};
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	applyModel(scope, token, delta, options) {
		if (!Number.isFinite(delta) || Math.abs(delta) > 6) return false;
		const scopeId = key(scope);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM moods WHERE scope=? AND token=? AND model_done=0").get(scopeId, token);
			if (!row) {
				this.db.exec("COMMIT");
				return false;
			}
			const before = this.value(row, options);
			const decay = 2 ** (-Math.max(0, this.now() - Number(row.at)) / (options.halfLifeHours * 36e5));
			const value = bound(before + (delta - Number(row.keyword_delta)) * decay);
			this.db.prepare("UPDATE moods SET value=?,at=?,model_done=1 WHERE scope=? AND token=?").run(value, this.now(), scopeId, token);
			if (value !== before) this.record(scopeId, value, value - before, "model");
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	history(scope) {
		return this.db.prepare("SELECT at,value,delta,source FROM mood_history WHERE scope=? ORDER BY seq DESC LIMIT 20").all(key(scope));
	}
	record(scope, value, delta, source) {
		this.db.prepare("INSERT INTO mood_history(scope,at,value,delta,source) VALUES(?,?,?,?,?)").run(scope, this.now(), value, delta, source);
		this.db.prepare("DELETE FROM mood_history WHERE scope=? AND seq NOT IN (SELECT seq FROM mood_history WHERE scope=? ORDER BY seq DESC LIMIT 20)").run(scope, scope);
	}
	remove(scope) {
		this.db.prepare("DELETE FROM moods WHERE scope=?").run(scope);
		this.db.prepare("DELETE FROM mood_inputs WHERE scope=?").run(scope);
		this.db.prepare("DELETE FROM mood_history WHERE scope=?").run(scope);
	}
	expire(scope, days) {
		const row = this.db.prepare("SELECT at FROM moods WHERE scope=?").get(scope);
		if (row && Number(row.at) < this.now() - days * 864e5) this.remove(scope);
	}
	cleanup(days) {
		const rows = this.db.prepare("SELECT scope FROM moods WHERE at<?").all(this.now() - days * 864e5);
		for (const row of rows) this.remove(String(row.scope));
	}
	purgeHash(hash) {
		const rows = this.db.prepare("SELECT scope FROM moods WHERE channel_hash=?").all(hash);
		for (const row of rows) this.remove(String(row.scope));
	}
};
const state = globalThis;
const stores = state.__agentLinkMoods__ ??= /* @__PURE__ */ new Map();
const getMoodStore = (config) => {
	const root = dirname(config.workspaceRoot);
	let store = stores.get(root);
	if (!store) {
		store = new MoodStore(root);
		stores.set(root, store);
	}
	return store;
};

export { MoodStore, getMoodStore, keywordMoodDelta, moodLabel, moodOptions, parseMoodJudgment };