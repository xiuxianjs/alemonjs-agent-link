import { getGroupChatPolicy, groupActivityPresets } from "./group-policy.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";

// src/social/group-settings.ts
const groupSettingsFields = [
	"activity",
	"quietHours",
	"maxPerHour",
	"interests",
	"wakeNames",
	"bannedWords",
	"voiceEnabled",
	"voiceAuto"
];
const groupActivities = [
	"quiet",
	"balanced",
	"active"
];
const maxInterests = 100;
const maxInterestLength = 40;
const maxWakeNames = 32;
const maxWakeNameLength = 20;
const maxBannedWords = 50;
const maxBannedWordLength = 30;
const scopeKey = (platform, channelId) => createHash("sha256").update(JSON.stringify([platform, channelId])).digest("hex");
const unique = (values) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
/** 校验并归一化单个字段；返回 undefined 表示清除该字段、回落到配置默认。 */
const normalizeGroupSetting = (field, value) => {
	if (field === "activity") {
		const activity = String(value);
		if (activity === "默认" || activity === "清除") return void 0;
		if (!groupActivities.includes(activity)) throw new Error("强度只能是 安静、正常 或 活跃。");
		return activity;
	}
	if (field === "quietHours") {
		if (value === void 0 || value === null || value === "默认" || value === "恢复") return void 0;
		if (value === "关闭") return [0, 0];
		const match = typeof value === "string" ? /^(\d{1,2})\s*[-–—]\s*(\d{1,2})$/u.exec(value.trim()) : null;
		const hours = Array.isArray(value) ? value : match ? match.slice(1).map(Number) : [];
		if (hours.length !== 2 || hours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23)) throw new Error("静默时段需要两个 0–23 的整点，例如 1-8；写“关闭”表示不静默。");
		return [hours[0], hours[1]];
	}
	if (field === "maxPerHour") {
		const text = String(value).trim();
		const number = /^\d+$/u.test(text) ? Number(text) : NaN;
		if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error("每小时上限需要 0–100 的整数。");
		return number;
	}
	if (field === "voiceEnabled" || field === "voiceAuto") {
		if (value === void 0 || value === null || value === "默认" || value === "恢复") return void 0;
		const text = String(value).toLowerCase();
		if ([
			"开",
			"开启",
			"on",
			"true",
			"1"
		].includes(text)) return true;
		if ([
			"关",
			"关闭",
			"off",
			"false",
			"0"
		].includes(text)) return false;
		throw new Error("语音开关只接受 开启 或 关闭。");
	}
	if (field === "interests" || field === "wakeNames" || field === "bannedWords") {
		if (value === void 0 || value === null || value === "清空") return void 0;
		const list = unique((Array.isArray(value) ? value.map(String) : String(value).split(/[,，\s]+/u)).filter(Boolean));
		const limit = field === "interests" ? 100 : field === "wakeNames" ? 32 : 50;
		const length = field === "interests" ? 40 : field === "wakeNames" ? 20 : 30;
		if (!list.length) return void 0;
		if (list.length > limit) throw new Error(`最多 ${limit} 个词。`);
		if (list.some((word) => word.length > length || word.startsWith("/"))) throw new Error(`每个词不超过 ${length} 字，且不能以 / 开头。`);
		return list;
	}
};
/** 群设置参与策略合并；活跃档位沿用与配置相同的预设，避免管理员自填极端参数。 */
const settingsToPolicy = (settings) => {
	const policy = {};
	if (settings.activity) policy.activity = settings.activity;
	if (settings.quietHours) policy.quietHours = settings.quietHours;
	if (settings.maxPerHour !== void 0) policy.maxPerHour = settings.maxPerHour;
	if (settings.interests) policy.interests = settings.interests;
	return policy;
};
/** 档位预设允许的上限，用于把“每小时上限”限制在只能往下的范围内。 */
const activityCeiling = (activity) => groupActivityPresets[activity].maxPerHour;
const describe = (value) => value === void 0 ? "" : Array.isArray(value) ? value.join(",") : String(value);
var GroupSettingsStore = class {
	now;
	db;
	constructor(root, now = Date.now) {
		this.now = now;
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		const path = join(root, "group-settings.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS group_settings (
        scope TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL, settings TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_settings_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
        field TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, operator TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS group_settings_audit_scope ON group_settings_audit(scope, at);`);
	}
	close() {
		this.db.close();
	}
	get(platform, channelId) {
		if (!platform || !channelId) return {};
		const row = this.db.prepare("SELECT settings FROM group_settings WHERE scope=?").get(scopeKey(platform, channelId));
		if (!row) return {};
		try {
			return JSON.parse(String(row.settings));
		} catch {
			return {};
		}
	}
	audit(platform, channelId, limit = 10) {
		return this.db.prepare("SELECT field,before,after,operator,at FROM group_settings_audit WHERE scope=? ORDER BY at DESC, id DESC LIMIT ?").all(scopeKey(platform, channelId), Math.max(1, Math.min(50, limit)));
	}
	/** 写入一个或多个字段；只做字段校验与审计，不限制修改次数。 */
	update(platform, channelId, operator, patch) {
		if (!platform || !channelId) return {
			ok: false,
			reason: "缺少群身份，无法保存本群设置。"
		};
		const now = this.now();
		const fields = Object.keys(patch);
		if (!fields.length) return {
			ok: false,
			reason: "没有需要保存的字段。"
		};
		for (const field of fields) if (!groupSettingsFields.includes(field)) return {
			ok: false,
			reason: "不支持的设置项。"
		};
		const normalized = {};
		try {
			for (const field of fields) normalized[field] = patch[field] === void 0 ? void 0 : normalizeGroupSetting(field, patch[field]);
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "设置值无效。"
			};
		}
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const previous = this.get(platform, channelId);
			const next = {
				...previous,
				...normalized
			};
			this.db.prepare(`INSERT INTO group_settings(scope,platform,channel_id,settings,updated_at,updated_by) VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET settings=excluded.settings,updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(scopeKey(platform, channelId), platform, channelId, JSON.stringify(next), now, operator);
			const insert = this.db.prepare("INSERT INTO group_settings_audit(scope,platform,channel_id,field,before,after,operator,at) VALUES(?,?,?,?,?,?,?,?)");
			for (const field of fields) insert.run(scopeKey(platform, channelId), platform, channelId, field, describe(previous[field]), describe(normalized[field]), operator, now);
			this.db.exec("COMMIT");
			return { ok: true };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	reset(platform, channelId, operator) {
		if (!platform || !channelId) return;
		const previous = this.get(platform, channelId);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM group_settings WHERE scope=?").run(scopeKey(platform, channelId));
			this.db.prepare("INSERT INTO group_settings_audit(scope,platform,channel_id,field,before,after,operator,at) VALUES(?,?,?,?,?,?,?,?)").run(scopeKey(platform, channelId), platform, channelId, "reset", JSON.stringify(previous), "", operator, this.now());
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	/** 退群、清群数据时清理本群设置与审计。 */
	purge(platform, channelId) {
		const scope = scopeKey(platform, channelId);
		this.db.prepare("DELETE FROM group_settings WHERE scope=?").run(scope);
		this.db.prepare("DELETE FROM group_settings_audit WHERE scope=?").run(scope);
	}
};
const processState = globalThis;
const stores = processState.__agentLinkGroupSettings__ ??= /* @__PURE__ */ new Map();
const getGroupSettingsStore = (config) => {
	const root = dirname(config.workspaceRoot);
	let store = stores.get(root);
	if (!store) {
		store = new GroupSettingsStore(root);
		stores.set(root, store);
	}
	return store;
};
/** 本群语音策略：allowed=false 一律文字；auto=false 只回应显式语音请求。 */
const groupVoicePolicy = (config, channelId, platform = "") => {
	try {
		const settings = getGroupSettingsStore(config).get(platform, channelId);
		return {
			allowed: settings.voiceEnabled !== false,
			auto: settings.voiceAuto !== false
		};
	} catch {
		return {
			allowed: true,
			auto: true
		};
	}
};
/** 本群生效的唤醒词 = 全局词表 + 群管理员补充（去重）。 */
const wakeNamesFor = (config, channelId, platform = "") => {
	try {
		const extra = getGroupSettingsStore(config).get(platform, channelId).wakeNames || [];
		return unique([...config.groupWakeNames, ...extra]);
	} catch {
		return [...config.groupWakeNames];
	}
};
/** 本群禁语词：只过滤机器人的群内输出，不影响用户消息。 */
const bannedWordsFor = (config, channelId, platform = "") => {
	try {
		return getGroupSettingsStore(config).get(platform, channelId).bannedWords || [];
	} catch {
		return [];
	}
};
/** 用等长的实心圆点遮盖禁语词，保持句子结构不被破坏。 */
const maskBannedWords = (text, words) => {
	if (!text || !words.length) return text;
	let output = text;
	for (const word of words) {
		if (!word) continue;
		const pattern = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
		output = output.replace(pattern, (match) => "＊".repeat(Math.max(1, Array.from(match).length)));
	}
	return output;
};
/** 叠加群设置的最终策略：默认值 → 配置显式值 → 群设置 → 配置再次覆盖（主人锁定）→ 按群覆盖。 */
const groupPolicy = (config, channelId, platform = "") => {
	try {
		return getGroupChatPolicy(config.groupChat, channelId, settingsToPolicy(getGroupSettingsStore(config).get(platform, channelId)));
	} catch {
		return getGroupChatPolicy(config.groupChat, channelId);
	}
};

export { GroupSettingsStore, activityCeiling, bannedWordsFor, getGroupSettingsStore, groupActivities, groupPolicy, groupSettingsFields, groupVoicePolicy, maskBannedWords, maxBannedWordLength, maxBannedWords, maxInterestLength, maxInterests, maxWakeNameLength, maxWakeNames, normalizeGroupSetting, settingsToPolicy, wakeNamesFor };