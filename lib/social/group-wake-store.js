import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// src/social/group-wake-store.ts
const groupWakeNamespace = (config) => JSON.stringify([config.workspaceRoot, config.dshHomeRoot]);
const key = (scope) => createHash("sha256").update(JSON.stringify([
	scope.namespace,
	scope.platform,
	scope.botId,
	scope.channelId
])).digest("hex");
const identity = (scope) => [
	scope.namespace,
	scope.platform,
	scope.botId,
	scope.channelId
].every((value) => typeof value === "string" && value.length > 0 && value.length <= 2e3);
const valid = (value) => Boolean(value && identity(value) && typeof value.id === "string" && value.id.length === 36 && typeof value.userId === "string" && value.userId.length > 0 && value.userId.length <= 200 && typeof value.reason === "string" && value.reason.trim() && value.reason.length <= 160 && !/[\r\n\0]/u.test(value.reason) && Number.isSafeInteger(value.createdAt) && Number.isSafeInteger(value.dueAt) && value.dueAt - value.createdAt >= 6e4 && value.dueAt - value.createdAt <= 36e5);
/** A claimed wake is never retried, including after process death or uncertain delivery. */
var GroupWakeStore = class {
	now;
	db;
	constructor(root, now = Date.now) {
		this.now = now;
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "group-wakes.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS group_wakes(scope TEXT PRIMARY KEY, namespace TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, due_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_wake_attempts(id TEXT PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS group_wake_attempts_scope ON group_wake_attempts(scope,at);`);
	}
	close() {
		this.db.close();
	}
	cleanup() {
		const now = this.now();
		this.db.prepare("DELETE FROM group_wake_attempts WHERE at<=?").run(now - 36e5);
		this.db.prepare("DELETE FROM group_wakes WHERE created_at>? OR due_at<?").run(now, now - 864e5);
		this.db.prepare("UPDATE group_wakes SET state=CASE WHEN state='running' THEN 'interrupted' ELSE 'expired' END WHERE state IN ('scheduled','running') AND due_at<?").run(now - 6e4);
	}
	schedule(scope, userId, seconds, reason) {
		const now = this.now();
		const plan = {
			...scope,
			id: randomUUID(),
			userId,
			reason,
			createdAt: now,
			dueAt: now + seconds * 1e3
		};
		if (!Number.isSafeInteger(seconds) || !valid(plan)) return {
			ok: false,
			message: "唤醒需为60–3600秒后，说明为1–160字单行文本，且群身份完整。"
		};
		this.cleanup();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!this.db.prepare("SELECT 1 FROM group_wakes WHERE scope=?").get(key(scope)) && Number(this.db.prepare("SELECT COUNT(*) AS n FROM group_wakes").get().n) >= 1e3) {
				this.db.exec("ROLLBACK");
				return {
					ok: false,
					message: "唤醒任务容量已满。"
				};
			}
			this.db.prepare(`INSERT INTO group_wakes VALUES(?,?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET payload=excluded.payload,state=excluded.state,created_at=excluded.created_at,due_at=excluded.due_at`).run(key(scope), scope.namespace, JSON.stringify(plan), "scheduled", plan.createdAt, plan.dueAt);
			this.db.exec("COMMIT");
			return {
				ok: true,
				state: "scheduled",
				dueAt: plan.dueAt,
				message: "已预约一次重新判断；不保证发言，新群消息会取消本预约。"
			};
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	cancel(scope) {
		return Number(this.db.prepare("DELETE FROM group_wakes WHERE scope=?").run(key(scope)).changes) > 0;
	}
	clear(namespace, channelId, scope, userId) {
		let changed = false;
		for (const row of this.db.prepare("SELECT scope,payload FROM group_wakes WHERE namespace=?").all(namespace)) {
			const plan = this.decode(row.payload);
			if (!plan || (channelId === void 0 || plan.channelId === channelId) && (scope?.platform === void 0 || plan.platform === scope.platform) && (scope?.botId === void 0 || plan.botId === scope.botId) && (userId === void 0 || plan.userId === userId)) changed = Number(this.db.prepare("DELETE FROM group_wakes WHERE scope=?").run(String(row.scope)).changes) > 0 || changed;
		}
		return changed;
	}
	status(scope) {
		this.cleanup();
		const row = this.db.prepare("SELECT state,due_at FROM group_wakes WHERE scope=?").get(key(scope));
		return {
			ok: true,
			state: row ? String(row.state) : "idle",
			...row ? { dueAt: Number(row.due_at) } : {}
		};
	}
	decode(payload) {
		try {
			if (typeof payload !== "string" || payload.length > 8e3) return void 0;
			const plan = JSON.parse(payload);
			if (Object.keys(plan).some((field) => ![
				"namespace",
				"platform",
				"botId",
				"channelId",
				"id",
				"userId",
				"reason",
				"createdAt",
				"dueAt"
			].includes(field))) return void 0;
			return valid(plan) ? plan : void 0;
		} catch {
			return;
		}
	}
	all(namespace) {
		this.cleanup();
		return this.db.prepare("SELECT payload FROM group_wakes WHERE namespace=? LIMIT 1000").all(namespace).flatMap((row) => {
			const plan = this.decode(row.payload);
			return plan?.namespace === namespace ? [plan] : [];
		});
	}
	due(namespace) {
		this.cleanup();
		const plans = [];
		for (const row of this.db.prepare("SELECT scope,payload FROM group_wakes WHERE namespace=? AND state='scheduled' AND due_at<=? ORDER BY due_at LIMIT 1000").all(namespace, this.now())) {
			const plan = this.decode(row.payload);
			if (!plan || key(plan) !== row.scope || plan.namespace !== namespace) this.db.prepare("DELETE FROM group_wakes WHERE scope=?").run(String(row.scope));
			else plans.push(plan);
		}
		return plans;
	}
	claim(plan, maxPerHour) {
		if (!valid(plan) || !Number.isSafeInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > 4) return false;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const now = this.now(), row = this.db.prepare("SELECT payload FROM group_wakes WHERE scope=? AND state='scheduled'").get(key(plan));
			const stored = this.decode(row?.payload);
			if (stored?.id !== plan.id || JSON.stringify(stored) !== JSON.stringify(plan) || now < plan.dueAt || now > plan.dueAt + 6e4 || now < plan.createdAt) {
				this.db.exec("ROLLBACK");
				return false;
			}
			const recent = now - 36e5;
			const perScope = Number(this.db.prepare("SELECT COUNT(*) AS n FROM group_wake_attempts WHERE scope=? AND at>?").get(key(plan), recent).n);
			const global = Number(this.db.prepare("SELECT COUNT(*) AS n FROM group_wake_attempts WHERE at>?").get(recent).n);
			this.db.prepare("UPDATE group_wakes SET state=? WHERE scope=?").run(perScope >= maxPerHour || global >= 60 ? "rate_limited" : "running", key(plan));
			if (perScope >= maxPerHour || global >= 60) {
				this.db.exec("COMMIT");
				return false;
			}
			this.db.prepare("INSERT INTO group_wake_attempts VALUES(?,?,?)").run(plan.id, key(plan), now);
			this.db.exec("COMMIT");
			return true;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	current(plan) {
		const row = this.db.prepare("SELECT payload FROM group_wakes WHERE scope=? AND state='running'").get(key(plan));
		return this.decode(row?.payload)?.id === plan.id && this.now() >= plan.createdAt && this.now() <= plan.dueAt + 6e4;
	}
	finish(plan, state) {
		if (!this.current(plan)) return;
		this.db.prepare("UPDATE group_wakes SET state=? WHERE scope=?").run(state, key(plan));
	}
};
const processState = globalThis;
const stores = processState.__agentLinkGroupWakeStores__ ??= /* @__PURE__ */ new Map();
const getGroupWakeStore = (config) => {
	const root = dirname(config.workspaceRoot);
	let store = stores.get(root);
	if (!store) {
		store = new GroupWakeStore(root);
		stores.set(root, store);
	}
	return store;
};

export { GroupWakeStore, getGroupWakeStore, groupWakeNamespace };