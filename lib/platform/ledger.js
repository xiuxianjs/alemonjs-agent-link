import { PlatformOperationError } from "./client.js";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// src/platform/ledger.ts
const hash = (text) => createHash("sha256").update(text).digest("hex");
var PlatformLedger = class {
	db;
	constructor(root) {
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "platform-actions.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS platform_actions(id TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,at INTEGER NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_cooldowns(id TEXT PRIMARY KEY,until_at INTEGER NOT NULL);`);
	}
	close() {
		this.db.close();
	}
	claimCooldown(scope, seconds, channelId = scope) {
		const result = this.db.prepare(`INSERT INTO platform_cooldowns VALUES(?,?) ON CONFLICT(id) DO UPDATE SET until_at=excluded.until_at WHERE until_at<=?`).run(`${hash(channelId)}:${hash(scope)}`, Date.now() + seconds * 1e3, Date.now());
		return Number(result.changes) > 0;
	}
	async run(context, operation, execute) {
		context.signal.throwIfAborted();
		if (!context.inputId && !context.requestId) return {
			ok: false,
			state: "rejected",
			message: "缺少输入标识，无法安全执行。"
		};
		const id = hash(JSON.stringify([
			context.platform,
			context.botId,
			context.channelId,
			context.userId,
			context.inputId || context.requestId,
			operation
		]));
		const pending = {
			ok: false,
			state: "unknown",
			message: "操作状态尚未确认，请先核查平台；不会自动重复执行。"
		};
		const claimed = this.db.prepare("INSERT OR IGNORE INTO platform_actions VALUES(?,?,?,?)").run(id, hash(context.channelId), Date.now(), JSON.stringify(pending));
		if (!Number(claimed.changes)) return JSON.parse(String(this.db.prepare("SELECT result FROM platform_actions WHERE id=?").get(id).result));
		let result = pending;
		try {
			await execute();
			result = {
				ok: true,
				state: "confirmed",
				message: "平台已确认完成。"
			};
		} catch (error) {
			if (error instanceof PlatformOperationError && [
				"validation",
				"rejected",
				"unsupported"
			].includes(error.kind)) result = {
				ok: false,
				state: "rejected",
				message: "平台拒绝操作或当前身份、权限不满足要求。"
			};
		}
		this.db.prepare("UPDATE platform_actions SET result=? WHERE id=?").run(JSON.stringify(result), id);
		return result;
	}
	purgeHash(hash) {
		this.db.prepare("DELETE FROM platform_actions WHERE scope_hash=?").run(hash);
		this.db.prepare("DELETE FROM platform_cooldowns WHERE id LIKE ?").run(`${hash}:%`);
	}
	cleanup(days) {
		this.db.prepare("DELETE FROM platform_actions WHERE at<?").run(Date.now() - days * 864e5);
		this.db.prepare("DELETE FROM platform_cooldowns WHERE until_at<?").run(Date.now());
	}
};
const state = globalThis;
const stores = state.__agentLinkPlatformLedger__ ??= /* @__PURE__ */ new Map();
const getPlatformLedger = (config) => {
	const root = dirname(config.workspaceRoot);
	let store = stores.get(root);
	if (!store) {
		store = new PlatformLedger(root);
		stores.set(root, store);
	}
	return store;
};

export { PlatformLedger, getPlatformLedger };