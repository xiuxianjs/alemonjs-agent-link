import { createHash } from "node:crypto";
import { join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// src/bili/comment-ledger.ts
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const day = (now) => new Date(now + 288e5).toISOString().slice(0, 10);
var BiliCommentLedger = class {
	db;
	constructor(root) {
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "bili-comments.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS comments (turn TEXT PRIMARY KEY, account TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, operation TEXT NOT NULL, result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS comments_account_day ON comments(account,day);`);
	}
	close() {
		this.db.close();
	}
	async run(context, account, operation, limits, execute) {
		context.signal.throwIfAborted();
		if (!context.inputId && !context.requestId) return {
			ok: false,
			state: "rejected",
			message: "缺少请求标识，无法执行评论。"
		};
		const turn = hash([
			context.platform,
			context.botId,
			context.channelId,
			context.userId,
			context.inputId || context.requestId
		]);
		const accountId = hash(account);
		const operationId = hash(operation);
		const now = Date.now();
		const pending = {
			ok: false,
			state: "unknown",
			message: "评论结果未确认，请先到 B 站核查；不会自动重试。"
		};
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const old = this.db.prepare("SELECT operation,result FROM comments WHERE turn=?").get(turn);
			if (old) {
				this.db.exec("COMMIT");
				return old.operation === operationId ? JSON.parse(String(old.result)) : {
					ok: false,
					state: "rejected",
					message: "本轮已有其他评论请求，不能再次发送。"
				};
			}
			const stat = this.db.prepare("SELECT count(*) AS total FROM comments WHERE account=? AND day=?").get(accountId, day(now));
			const last = this.db.prepare("SELECT max(at) AS at FROM comments WHERE account=?").get(accountId);
			if (Number(stat.total) >= limits.max || last.at !== null && now - Number(last.at) < limits.cooldown * 1e3) {
				this.db.exec("COMMIT");
				return {
					ok: false,
					state: "rejected",
					message: "评论次数已达上限或仍在冷却中。"
				};
			}
			this.db.prepare("INSERT INTO comments VALUES(?,?,?,?,?,?)").run(turn, accountId, day(now), now, operationId, JSON.stringify(pending));
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		let state = "unknown";
		try {
			state = await execute();
		} catch {}
		const outcome = state === "confirmed" ? {
			ok: true,
			state,
			message: "B 站已确认评论发布。"
		} : state === "rejected" ? {
			ok: false,
			state,
			message: "B 站拒绝了评论，请检查登录状态或平台限制。"
		} : pending;
		this.db.prepare("UPDATE comments SET result=? WHERE turn=?").run(JSON.stringify(outcome), turn);
		return outcome;
	}
};
const shared = globalThis;
const stores = shared.__agentLinkBiliCommentLedgers__ ??= /* @__PURE__ */ new Map();
const getBiliCommentLedger = (root) => {
	let store = stores.get(root);
	if (!store) {
		store = new BiliCommentLedger(root);
		stores.set(root, store);
	}
	return store;
};

export { BiliCommentLedger, getBiliCommentLedger };