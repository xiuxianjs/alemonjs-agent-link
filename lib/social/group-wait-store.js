import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// src/social/group-wait-store.ts
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (scope) => hash([
	scope.namespace,
	scope.channelId,
	scope.platform,
	scope.botId
]);
const valid = (value) => Boolean(value && typeof value.platform === "string" && value.platform.length <= 200 && typeof value.userKey === "string" && value.userKey.length > 0 && value.userKey.length <= 1e3 && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && value.plan && Array.isArray(value.plan.speakerIds) && value.plan.speakerIds.length >= 1 && value.plan.speakerIds.length <= 5 && value.plan.speakerIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200) && typeof value.plan.keyword === "string" && value.plan.keyword.length <= 40 && !/[\r\n\0]/u.test(value.plan.keyword) && Number.isSafeInteger(value.plan.expiresAt) && value.plan.expiresAt >= value.createdAt + 15e3 && value.plan.expiresAt <= value.createdAt + 3e5);
const clean = (value) => ({
	platform: value.platform,
	userKey: value.userKey,
	createdAt: value.createdAt,
	plan: {
		speakerIds: [...new Set(value.plan.speakerIds)],
		keyword: value.plan.keyword,
		expiresAt: value.plan.expiresAt
	}
});
/** Short-lived recovery for one active coordinator; not a distributed reply lock. */
var GroupWaitStore = class {
	db;
	constructor(root) {
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "group-waits.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS waits(scope TEXT PRIMARY KEY, namespace TEXT NOT NULL, channel TEXT NOT NULL,
        owner TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS waits_expiry ON waits(expires_at);`);
	}
	close() {
		this.db.close();
	}
	load(scope, now) {
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("等待恢复时间无效。");
		this.db.prepare("DELETE FROM waits WHERE expires_at<=? OR created_at>?").run(now, now);
		const row = this.db.prepare("SELECT CASE WHEN length(payload)<=16384 THEN payload END AS payload FROM waits WHERE scope=?").get(key(scope));
		if (!row) return;
		try {
			const value = JSON.parse(String(row.payload));
			if (!valid(value) || value.platform !== scope.platform || value.createdAt > now || value.plan.expiresAt <= now) throw new Error("invalid");
			return clean(value);
		} catch {
			this.remove(scope);
		}
	}
	save(scope, value) {
		if (!valid(value) || value.platform !== scope.platform) throw new Error("等待持久状态无效。");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM waits WHERE expires_at<=?").run(value.createdAt);
			if (Number(this.db.prepare("SELECT count(*) AS n FROM waits").get().n) >= 1e3 && !this.db.prepare("SELECT 1 FROM waits WHERE scope=?").get(key(scope))) throw new Error("等待恢复容量已满。");
			this.db.prepare("INSERT OR REPLACE INTO waits VALUES(?,?,?,?,?,?,?)").run(key(scope), hash(scope.namespace), hash(scope.channelId), hash(value.userKey), value.createdAt, value.plan.expiresAt, JSON.stringify(clean(value)));
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	remove(scope, userKey) {
		const exact = scope.platform !== void 0 || scope.botId !== void 0;
		const params = [hash(scope.namespace), hash(scope.channelId)];
		let where = "namespace=? AND channel=?";
		if (exact) {
			where += " AND scope=?";
			params.push(key({
				...scope,
				platform: scope.platform || "",
				botId: scope.botId || ""
			}));
		}
		if (userKey !== void 0) {
			where += " AND owner=?";
			params.push(hash(userKey));
		}
		return Number(this.db.prepare(`DELETE FROM waits WHERE ${where}`).run(...params).changes) > 0;
	}
	persistence(scope, failed) {
		return {
			load: (now) => this.load(scope, now),
			save: (value) => {
				if (value) this.save(scope, value);
				else this.remove(scope);
			},
			failed
		};
	}
};
const groupWaitNamespace = (config) => JSON.stringify([config.workspaceRoot, config.dshHomeRoot]);
const processState = globalThis;
const getGroupWaitStore = (config) => {
	const root = dirname(config.workspaceRoot);
	if (processState.__agentLinkGroupWaitStore__?.root !== root) {
		const store = new GroupWaitStore(root);
		processState.__agentLinkGroupWaitStore__?.store.close();
		processState.__agentLinkGroupWaitStore__ = {
			root,
			store
		};
	}
	return processState.__agentLinkGroupWaitStore__.store;
};

export { GroupWaitStore, getGroupWaitStore, groupWaitNamespace };