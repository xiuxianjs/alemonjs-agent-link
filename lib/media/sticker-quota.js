import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";

// src/media/sticker-quota.ts
const hash = (value) => createHash("sha256").update(value).digest("hex");
/** Rolling attempt limits and event deduplication shared by processes using one data directory. */
var StickerCollectionQuota = class {
	db;
	constructor(root) {
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "sticker-auto-quota.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS attempts (event_key TEXT PRIMARY KEY,user_key TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
      CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_key);`);
	}
	close() {
		this.db.close();
	}
	claim(input) {
		if (typeof input.eventKey !== "string" || !input.eventKey || input.eventKey.length > 4096 || typeof input.userKey !== "string" || !input.userKey || input.userKey.length > 4096 || !Number.isSafeInteger(input.maxPerHour) || input.maxPerHour < 1 || input.maxPerHour > 100 || !Number.isSafeInteger(input.now) || input.now < 0) throw new Error("表情收集额度参数无效。");
		const event = hash(input.eventKey), user = hash(input.userKey);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM attempts WHERE at<=?").run(input.now - 36e5);
			const count = this.db.prepare("SELECT count(*) AS total,sum(CASE WHEN user_key=? THEN 1 ELSE 0 END) AS user FROM attempts").get(user);
			let accepted = false;
			if (Number(count.total) < input.maxPerHour && Number(count.user) < 20) accepted = Number(this.db.prepare("INSERT OR IGNORE INTO attempts(event_key,user_key,at) VALUES(?,?,?)").run(event, user, input.now).changes) === 1;
			this.db.exec("COMMIT");
			return accepted;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
};
const processState = globalThis;
const getStickerCollectionQuota = (config) => {
	const root = dirname(config.workspaceRoot);
	if (processState.__agentLinkStickerQuota__?.root !== root) {
		const store = new StickerCollectionQuota(root);
		processState.__agentLinkStickerQuota__?.store.close();
		processState.__agentLinkStickerQuota__ = {
			root,
			store
		};
	}
	return processState.__agentLinkStickerQuota__.store;
};

export { StickerCollectionQuota, getStickerCollectionQuota };