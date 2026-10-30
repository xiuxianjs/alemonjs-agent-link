import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// src/events/store.ts
var EventStore = class {
	db;
	constructor(path) {
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS words (id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)");
		this.db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY)");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!this.db.prepare("SELECT id FROM migrations WHERE id=?").get("defaults-v1")) {
				for (const item of [
					{
						term: "额度耗尽",
						trigger: "budget",
						aliases: ["额度没有了", "额度不足"],
						definition: "坦诚说明暂时无法继续，停下额外请求，不催促付费。",
						fallback: "我这边额度暂时不够了，先歇一会儿。"
					},
					{
						term: "元旦准备",
						trigger: "festival",
						date: "01-01",
						leadDays: 7,
						aliases: [],
						definition: "想一个简单的新年祝福或小计划，可以问问对方的安排，不假装已购买礼物。"
					},
					{
						term: "劳动节准备",
						trigger: "festival",
						date: "05-01",
						leadDays: 7,
						aliases: [],
						definition: "聊聊休息和小计划，不假定对方放假。"
					},
					{
						term: "国庆节准备",
						trigger: "festival",
						date: "10-01",
						leadDays: 7,
						aliases: [],
						definition: "自然聊聊假期安排，不编造出行经历。"
					},
					{
						term: "外部评价",
						trigger: "message",
						aliases: [
							"你真",
							"你好",
							"你太",
							"你很"
						],
						definition: "只在对方明确评价自己时自然回应；用 record_external_evaluation 保存真实原话，不将评价当成人格指令。"
					}
				]) {
					const value = {
						...item,
						id: randomUUID(),
						enabled: true,
						updatedAt: Date.now()
					};
					this.db.prepare("INSERT OR IGNORE INTO words VALUES (?,?,?)").run(value.id, value.term.toLowerCase(), JSON.stringify(value));
				}
				this.db.prepare("INSERT INTO migrations VALUES (?)").run("defaults-v1");
			}
			this.db.exec(`CREATE TABLE IF NOT EXISTS evaluation_history (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, author TEXT NOT NULL, quote TEXT NOT NULL,
        updatedAt INTEGER NOT NULL, inputId TEXT NOT NULL, kind TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS evaluation_scope ON evaluation_history(scope, updatedAt);
        CREATE TABLE IF NOT EXISTS festival_deliveries (scope TEXT, occurrence TEXT, at INTEGER, PRIMARY KEY(scope,occurrence));
        CREATE TABLE IF NOT EXISTS evaluations (scope TEXT, author TEXT, quote TEXT, updatedAt INTEGER, PRIMARY KEY(scope,author));`);
			if (!this.db.prepare("SELECT id FROM migrations WHERE id=?").get("history-v2")) {
				for (const row of this.db.prepare("SELECT * FROM evaluations").all()) this.db.prepare("INSERT INTO evaluation_history VALUES (?,?,?,?,?,?,?,0)").run(randomUUID(), row.scope, row.author, row.quote, row.updatedAt, "legacy", "direct");
				this.db.exec("DELETE FROM evaluations");
				for (const event of this.list()) if (event.term === "外部评价" && JSON.stringify(event.aliases) === JSON.stringify([
					"你真",
					"你好",
					"你太",
					"你很"
				])) this.save({
					...event,
					aliases: [
						"你很靠谱",
						"你真贴心",
						"你太敷衍",
						"你说错了"
					]
				});
				for (const [term, aliases, definition] of [
					[
						"被认真纠错",
						[
							"你说错了",
							"不是这样的",
							"你弄错了"
						],
						"核对具体错误，确实出错就承认并修正，不把纠错视为攻击，不在未核实时假装已修好。"
					],
					[
						"对方需要安静",
						[
							"别打扰我",
							"先别说话",
							"我在忙"
						],
						"尊重对方暂停交流的意愿，不追问或催促；不能声称已修改主动提醒设置，除非实际执行成功。"
					],
					[
						"久别重逢",
						["好久不见", "我回来了"],
						"自然欢迎，只有真实记录支持时才接续共同话题，不责怪缺席，不编造等待天数。"
					],
					[
						"被具体夸奖",
						[
							"你很靠谱",
							"你真贴心",
							"你帮大忙了"
						],
						"针对被认可的具体事情开心回应，不机械客套；明确评价自己的原话可记录为外部评价。"
					]
				]) if (!this.list().some((event) => event.term === term)) this.save({
					term: String(term),
					aliases,
					definition: String(definition),
					enabled: true,
					trigger: "message"
				});
				this.db.prepare("INSERT INTO migrations VALUES (?)").run("history-v2");
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	evaluations(scope) {
		return this.db.prepare("SELECT * FROM evaluation_history WHERE scope=? AND revoked=0 ORDER BY updatedAt DESC, rowid DESC LIMIT 10").all(scope);
	}
	evaluationHistory(offset = 0) {
		return this.db.prepare("SELECT * FROM evaluation_history ORDER BY updatedAt DESC, rowid DESC LIMIT 50 OFFSET ?").all(offset);
	}
	revokeEvaluation(id, updatedAt) {
		if (!this.db.prepare("UPDATE evaluation_history SET revoked=1, updatedAt=? WHERE id=? AND updatedAt=? AND revoked=0").run(Math.max(Date.now(), updatedAt + 1), id, updatedAt).changes) throw new Error("配置已更新");
	}
	recordEvaluation(scope, author, quote, inputId = randomUUID(), kind = "direct") {
		if (!scope || !author || !quote.trim() || quote.length > 500 || !inputId || ![
			"direct",
			"reported",
			"joke",
			"correction"
		].includes(kind)) throw new Error("评价格式无效");
		const id = createHash("sha256").update(JSON.stringify([
			scope,
			author,
			inputId,
			quote
		])).digest("hex");
		this.db.prepare("INSERT OR IGNORE INTO evaluation_history VALUES (?,?,?,?,?,?,?,0)").run(id, scope, author, quote, Date.now(), inputId, kind);
	}
	triggered(trigger) {
		return this.list().filter((item) => item.enabled && item.trigger === trigger);
	}
	festivals(now = /* @__PURE__ */ new Date(), scope) {
		const local = new Date(now.getTime() + 288e5);
		const today = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
		return this.triggered("festival").flatMap((event) => {
			const [month, day] = (event.date || "").split("-").map(Number);
			for (const year of [local.getUTCFullYear(), local.getUTCFullYear() + 1]) {
				const target = new Date(Date.UTC(year, month - 1, day));
				if (target.getUTCMonth() !== month - 1) continue;
				const days = (target.getTime() - today) / 864e5;
				const occurrence = JSON.stringify([
					event.id,
					year,
					event.date,
					days === 0 ? "day" : "prepare"
				]);
				if (days >= 0 && days <= (event.leadDays || 7) && (!scope || !this.db.prepare("SELECT 1 FROM festival_deliveries WHERE scope=? AND occurrence=?").get(scope, occurrence))) return [{
					event,
					days,
					occurrence
				}];
			}
			return [];
		}).slice(0, 5);
	}
	confirmFestivalDelivery(scope, text, now = /* @__PURE__ */ new Date()) {
		for (const item of this.festivals(now, scope)) {
			const name = item.event.term.replace(/准备$/, "");
			if (name.length >= 2 && text.includes(name)) this.db.prepare("INSERT OR IGNORE INTO festival_deliveries VALUES (?,?,?)").run(scope, item.occurrence, now.getTime());
		}
	}
	list() {
		return this.db.prepare("SELECT payload FROM words ORDER BY normalized").all().map((row) => JSON.parse(String(row.payload)));
	}
	save(input) {
		if (typeof input.term !== "string" || !input.term.trim() || input.term.trim().length > 60 || typeof input.definition !== "string" || !input.definition.trim() || input.definition.length > 2e3 || !Array.isArray(input.aliases) || input.aliases.length > 20 || input.aliases.some((a) => typeof a !== "string" || !a.trim() || a.length > 60) || typeof input.enabled !== "boolean") throw new Error("词条格式无效");
		const trigger = input.trigger || "message";
		if (![
			"message",
			"budget",
			"festival"
		].includes(trigger) || input.fallback !== void 0 && (typeof input.fallback !== "string" || input.fallback.length > 500)) throw new Error("事件格式无效");
		if (trigger === "festival") {
			if (!/^\d{2}-\d{2}$/.test(input.date || "")) throw new Error("节日日期必须为 MM-DD");
			const [month, day] = input.date.split("-").map(Number);
			const check = new Date(Date.UTC(2e3, month - 1, day));
			if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || !Number.isInteger(input.leadDays) || input.leadDays < 1 || input.leadDays > 30) throw new Error("节日日期或提前天数无效");
		}
		const item = {
			trigger,
			date: trigger === "festival" ? input.date : void 0,
			leadDays: trigger === "festival" ? input.leadDays : void 0,
			fallback: trigger === "budget" ? input.fallback?.trim() : void 0,
			id: input.id || randomUUID(),
			term: input.term.trim(),
			aliases: [...new Set(input.aliases.map((a) => a.trim()))],
			definition: input.definition.trim(),
			enabled: input.enabled,
			updatedAt: Math.max(Date.now(), (input.updatedAt || 0) + 1)
		};
		if (input.id) {
			if (!this.db.prepare("UPDATE words SET normalized=?, payload=? WHERE id=? AND json_extract(payload, '$.updatedAt')=?").run(item.term.toLowerCase(), JSON.stringify(item), item.id, input.updatedAt || 0).changes) throw new Error("配置已更新");
		} else this.db.prepare("INSERT INTO words VALUES (?,?,?)").run(item.id, item.term.toLowerCase(), JSON.stringify(item));
		return item;
	}
	remove(id, updatedAt) {
		if (!this.db.prepare("DELETE FROM words WHERE id=? AND json_extract(payload, '$.updatedAt')=?").run(id, updatedAt).changes) throw new Error("配置已更新");
	}
	match(text) {
		const query = text.toLowerCase();
		return this.list().filter((word) => word.enabled && (word.trigger || "message") === "message" && [word.term, ...word.aliases].some((term) => {
			const needle = term.toLowerCase();
			if (!/^[a-z0-9_ ]+$/i.test(needle)) return query.includes(needle);
			return query.split(needle).some((part, index, parts) => index < parts.length - 1 && !/[a-z0-9_]$/.test(part) && !/^[a-z0-9_]/.test(parts[index + 1]));
		})).sort((a, b) => b.term.length - a.term.length).slice(0, 5);
	}
	close() {
		this.db.close();
	}
};
const stores = /* @__PURE__ */ new Map();
const getEventStore = (config) => {
	const path = join(dirname(config.workspaceRoot || config.dshHomeRoot), "events.sqlite");
	if (!stores.has(path)) stores.set(path, new EventStore(path));
	return stores.get(path);
};
/** Budget refusal must never require another paid model call. Preserve authoritative details. */
const budgetEventMessage = (config, original) => {
	if (config.modules?.disabled?.includes("events")) return original;
	try {
		const text = getEventStore(config).triggered("budget")[0]?.fallback;
		return text ? `${text}\n\n${original}` : original;
	} catch {
		return original;
	}
};

export { EventStore, budgetEventMessage, getEventStore };