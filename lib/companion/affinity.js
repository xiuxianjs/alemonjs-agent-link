import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// src/companion/affinity.ts
const hash = (text) => createHash("sha256").update(text).digest("hex");
const key = (scope) => {
	if (Object.values(scope).some((value) => !value)) throw new Error("好感度身份不完整");
	return hash(JSON.stringify([
		scope.platform,
		scope.channelId,
		scope.userId,
		scope.personaId
	]));
};
const affinityLabel = (score) => score >= 90 ? "挚友" : score >= 80 ? "亲近朋友" : score >= 60 ? "朋友" : "相识";
var AffinityStore = class {
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
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS affinity (scope TEXT PRIMARY KEY, channel_hash TEXT NOT NULL, score INTEGER NOT NULL, day TEXT NOT NULL, gained INTEGER NOT NULL, last_gain INTEGER NOT NULL, updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS affinity_seen (scope TEXT NOT NULL, input TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(scope,input));`);
	}
	snapshot(scope) {
		const score = Number(this.db.prepare("SELECT score FROM affinity WHERE scope=?").get(key(scope))?.score ?? 50);
		return {
			score,
			label: affinityLabel(score)
		};
	}
	record(scope, inputId, text, delta = 0) {
		const id = key(scope);
		if (!Number.isInteger(delta) || ![
			-3,
			0,
			1
		].includes(delta)) throw new Error("好感度变化无效");
		if (!delta || !inputId || text.trim().length < 4 || text.trimStart().startsWith("/")) return this.snapshot(scope);
		const now = this.now();
		const day = new Date(now + 288e5).toISOString().slice(0, 10);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const seen = this.db.prepare("INSERT OR IGNORE INTO affinity_seen VALUES(?,?,?)").run(id, hash(inputId), now);
			const evidence = seen.changes ? this.db.prepare("INSERT OR IGNORE INTO affinity_seen VALUES(?,?,?)").run(id, hash("evidence:" + text.trim().toLowerCase()), now) : void 0;
			if (seen.changes && evidence?.changes) {
				const row = this.db.prepare("SELECT * FROM affinity WHERE scope=?").get(id);
				const gained = row?.day === day ? Number(row.gained) : 0;
				const eligible = gained + Math.abs(delta) <= 3 && (!row || now - Number(row.last_gain) >= 6e5);
				const score = Math.max(0, Math.min(100, Number(row?.score ?? 50) + (eligible ? delta : 0)));
				this.db.prepare("INSERT OR REPLACE INTO affinity VALUES(?,?,?,?,?,?,?)").run(id, hash(scope.channelId), score, day, gained + (eligible ? Math.abs(delta) : 0), eligible ? now : Number(row?.last_gain || 0), now);
			}
			this.db.exec("COMMIT");
			return this.snapshot(scope);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	purgeHash(channelHash) {
		this.db.prepare("DELETE FROM affinity_seen WHERE scope IN (SELECT scope FROM affinity WHERE channel_hash=?)").run(channelHash);
		this.db.prepare("DELETE FROM affinity WHERE channel_hash=?").run(channelHash);
	}
	cleanup(days) {
		const cutoff = this.now() - days * 864e5;
		this.db.prepare("DELETE FROM affinity_seen WHERE at<?").run(cutoff);
		this.db.prepare("DELETE FROM affinity WHERE updated<?").run(cutoff);
	}
	close() {
		this.db.close();
	}
};
const stores = /* @__PURE__ */ new Map();
const getAffinityStore = (config) => {
	const path = join(dirname(config.workspaceRoot), "affinity.sqlite");
	if (!stores.has(path)) stores.set(path, new AffinityStore(path));
	return stores.get(path);
};

export { AffinityStore, affinityLabel, getAffinityStore };