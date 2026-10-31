import { recentNewsDay } from "./news.js";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

// src/group-topics/store.ts
const tags = (values) => [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
const topicSimilarity = (left, right) => {
	const a = tags(left);
	const b = tags(right);
	const union = /* @__PURE__ */ new Set([...a, ...b]);
	return union.size ? a.filter((tag) => b.includes(tag)).length / union.size : 0;
};
/** This repository never sends messages. Dispatchers must revalidate candidates before delivery. */
var GroupTopicStore = class {
	now;
	db;
	constructor(root, now = Date.now) {
		this.now = now;
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "group-topics.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries(group_id TEXT NOT NULL, topic_id TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY(group_id,topic_id));
      CREATE TABLE IF NOT EXISTS topic_inbox(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_activity(group_id TEXT PRIMARY KEY, analyzed_at INTEGER NOT NULL DEFAULT 0, collected_at INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS topic_runs(seq INTEGER PRIMARY KEY,group_id TEXT NOT NULL,stage TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL);`);
	}
	close() {
		this.db.close();
	}
	saveProfile(profile, automatic = false) {
		const existing = this.profile(profile.id);
		if (existing && (existing.platform !== profile.platform || existing.botId !== profile.botId || existing.channelId !== profile.channelId)) throw new Error("群档案身份不可变更");
		if (![
			profile.id,
			profile.platform,
			profile.botId,
			profile.channelId,
			profile.positioning
		].every((value) => typeof value === "string" && value.trim())) throw new Error("群话题档案缺少身份或定位");
		if (![
			profile.enabled,
			profile.shareOut,
			profile.receiveShared
		].every((value) => typeof value === "boolean")) throw new Error("群话题权限无效");
		if (profile.positioning.length > 300 || [...profile.tags, ...profile.blockedTags].some((tag) => typeof tag !== "string" || tag.length > 40)) throw new Error("群定位或标签过长");
		const normalized = {
			...profile,
			manual: automatic ? profile.manual === true : true,
			tags: tags(profile.tags),
			blockedTags: tags(profile.blockedTags)
		};
		if (normalized.tags.length > 100 || normalized.blockedTags.length > 100) throw new Error("群话题标签过多");
		this.db.prepare("INSERT OR REPLACE INTO profiles VALUES(?,?)").run(profile.id, JSON.stringify(normalized));
	}
	observe(profile, messageId, text) {
		if (!this.profile(profile.id)) this.saveProfile(profile, true);
		if (!this.profile(profile.id)?.enabled) return;
		const id = createHash("sha256").update(JSON.stringify([profile.id, messageId])).digest("hex");
		this.db.prepare("INSERT OR IGNORE INTO topic_inbox VALUES(?,?,?,?)").run(id, profile.id, text.slice(0, 1500), this.now());
		this.db.prepare("INSERT OR IGNORE INTO topic_activity(group_id) VALUES(?)").run(profile.id);
		this.db.prepare("DELETE FROM topic_inbox WHERE at<?").run(this.now() - 864e5);
		this.db.prepare("DELETE FROM topic_inbox WHERE group_id=? AND id NOT IN (SELECT id FROM topic_inbox WHERE group_id=? ORDER BY at DESC,rowid DESC LIMIT 20)").run(profile.id, profile.id);
	}
	pending(groupId) {
		return this.db.prepare("SELECT id,text FROM topic_inbox WHERE group_id=? ORDER BY at LIMIT 20").all(groupId);
	}
	activity(groupId) {
		return this.db.prepare("SELECT analyzed_at,collected_at,reason FROM topic_activity WHERE group_id=?").get(groupId) || {
			analyzed_at: 0,
			collected_at: 0,
			reason: "pending"
		};
	}
	recordRun(groupId, stage, reason) {
		this.db.prepare("INSERT INTO topic_runs(group_id,stage,reason,at) VALUES(?,?,?,?)").run(groupId, stage, reason.slice(0, 500), this.now());
		this.db.prepare("DELETE FROM topic_runs WHERE group_id=? AND seq NOT IN (SELECT seq FROM topic_runs WHERE group_id=? ORDER BY seq DESC LIMIT 30)").run(groupId, groupId);
	}
	runs(groupId) {
		return this.db.prepare("SELECT stage,reason,at FROM topic_runs WHERE group_id=? ORDER BY seq DESC LIMIT 30").all(groupId);
	}
	finishAnalysis(groupId, ids, reason) {
		this.recordRun(groupId, "analysis", reason);
		this.db.prepare("INSERT INTO topic_activity(group_id,analyzed_at,reason) VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET analyzed_at=excluded.analyzed_at,reason=excluded.reason").run(groupId, this.now(), reason);
		for (const id of ids) this.db.prepare("DELETE FROM topic_inbox WHERE group_id=? AND id=?").run(groupId, id);
	}
	finishCollection(groupId, reason) {
		this.recordRun(groupId, "collection", reason);
		this.db.prepare("INSERT INTO topic_activity(group_id,collected_at,reason) VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET collected_at=excluded.collected_at,reason=excluded.reason").run(groupId, this.now(), reason);
	}
	profiles() {
		return this.db.prepare("SELECT body FROM profiles ORDER BY id").all().map((row) => JSON.parse(String(row.body)));
	}
	topics() {
		this.cleanup();
		return this.db.prepare("SELECT body FROM topics ORDER BY id").all().map((row) => JSON.parse(String(row.body)));
	}
	removeTopic(id) {
		this.db.prepare("DELETE FROM topics WHERE id=?").run(id);
	}
	profile(id) {
		const row = this.db.prepare("SELECT body FROM profiles WHERE id=?").get(id);
		return row ? JSON.parse(String(row.body)) : void 0;
	}
	addTopic(topic) {
		if (!Array.isArray(topic.tags) || !topic.tags.length || topic.tags.length > 100 || topic.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 40)) throw new Error("话题标签无效");
		if (topic.approved !== true || !topic.id.trim() || !topic.summary.trim() || topic.summary.length > 1200) throw new Error("话题必须经过审核并具有摘要");
		if (!Number.isFinite(topic.publishedAt) || !Number.isFinite(topic.expiresAt) || topic.publishedAt > this.now() || topic.expiresAt <= this.now() || topic.expiresAt <= topic.publishedAt) throw new Error("话题时间无效");
		if (topic.origin === "news" || topic.origin === "public-video") {
			if (!recentNewsDay(topic.publishedAt, this.now())) throw new Error("新闻不是今天或昨天发布");
			const url = new URL(topic.sourceUrl || "");
			if (topic.origin === "public-video" && (url.hostname !== "www.bilibili.com" || !/^\/video\/BV[0-9A-Za-z]{10}\/?$/u.test(url.pathname))) throw new Error("视频来源无效");
			if (url.protocol !== "https:" || url.username || url.password || topic.sourceGroup) throw new Error("新闻来源无效");
		} else if (topic.origin !== "human-discussion" || !topic.sourceGroup || !this.profile(topic.sourceGroup)?.shareOut) throw new Error("群话题来源未授权");
		return Boolean(this.db.prepare("INSERT OR IGNORE INTO topics VALUES(?,?)").run(topic.id, JSON.stringify({
			...topic,
			tags: tags(topic.tags)
		})).changes);
	}
	candidates(groupId) {
		this.cleanup();
		const target = this.profile(groupId);
		if (!target?.enabled) return [];
		const sent = new Set(this.db.prepare("SELECT topic_id FROM deliveries WHERE group_id=?").all(groupId).map((row) => String(row.topic_id)));
		return this.db.prepare("SELECT body FROM topics").all().flatMap((row) => {
			const topic = JSON.parse(String(row.body));
			if (sent.has(topic.id) || topic.expiresAt <= this.now() || topic.publishedAt > this.now() || topic.sourceGroup === groupId || (topic.origin === "news" || topic.origin === "public-video") && !recentNewsDay(topic.publishedAt, this.now()) || topic.tags.some((tag) => target.blockedTags.includes(tag))) return [];
			if (topic.sourceGroup) {
				const source = this.profile(topic.sourceGroup);
				if (!target.receiveShared || !source?.shareOut || source.botId !== target.botId || source.platform !== target.platform || topicSimilarity(source.tags, target.tags) === 0) return [];
			}
			const score = topicSimilarity(topic.tags, target.tags);
			return score > 0 ? [{
				topic,
				score
			}] : [];
		}).sort((a, b) => b.score - a.score || b.topic.publishedAt - a.topic.publishedAt);
	}
	cleanup() {
		this.db.prepare("DELETE FROM topic_inbox WHERE at<?").run(this.now() - 864e5);
		this.db.prepare("DELETE FROM topics WHERE json_extract(body,'$.expiresAt')<=?").run(this.now());
		this.db.prepare("DELETE FROM deliveries WHERE topic_id NOT IN (SELECT id FROM topics)").run();
	}
	recordDelivery(groupId, topicId) {
		this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?)").run(groupId, topicId, this.now());
	}
	purgeHash(hash) {
		for (const row of this.db.prepare("SELECT body FROM profiles").all()) {
			const profile = JSON.parse(String(row.body));
			if (createHash("sha256").update(profile.channelId).digest("hex") === hash) this.purgeGroup(profile.id);
		}
	}
	purgeGroup(groupId) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM topics WHERE json_extract(body,'$.sourceGroup')=?").run(groupId);
			this.db.prepare("DELETE FROM deliveries WHERE group_id=?").run(groupId);
			this.db.prepare("DELETE FROM profiles WHERE id=?").run(groupId);
			this.db.prepare("DELETE FROM topic_inbox WHERE group_id=?").run(groupId);
			this.db.prepare("DELETE FROM topic_activity WHERE group_id=?").run(groupId);
			this.db.prepare("DELETE FROM topic_runs WHERE group_id=?").run(groupId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
};
const groupTopicId = (platform, botId, channelId) => createHash("sha256").update(JSON.stringify([
	platform,
	botId,
	channelId
])).digest("hex");
const stores = /* @__PURE__ */ new Map();
const getGroupTopicStore = (config) => {
	const root = dirname(config.workspaceRoot);
	let store = stores.get(root);
	if (!store) {
		store = new GroupTopicStore(root);
		stores.set(root, store);
	}
	return store;
};

export { GroupTopicStore, getGroupTopicStore, groupTopicId, topicSimilarity };