import { resolveDSHConfig } from "../dsh/config.js";
import { AdminInputError } from "./admin-error.js";
import { getAdminStore } from "./admin-panel.js";
import { randomUUID } from "node:crypto";
import { getConfig } from "alemonjs";

// src/panel/general-settings.ts
const generalFields = [
	"groupWakeNames",
	"transport",
	"runtimeMode",
	"aiEnabled",
	"aiDisabledReason",
	"persona",
	"privateChatAccess",
	"privateAutoReply",
	"maxMessageLength",
	"bubbleDelayMs",
	"privateHistoryMaxTurns"
];
const validateGeneralSettings = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminInputError("设置内容无效");
	const values = value;
	if (Object.keys(values).some((key) => !generalFields.includes(key))) throw new AdminInputError("包含不支持的设置项");
	if (Object.values(values).some((item) => item === null || item === void 0)) throw new AdminInputError("设置值不能为空");
	if (values.persona !== void 0 && !["assistant", "dafeiyu"].includes(String(values.persona))) throw new AdminInputError("请选择有效的默认人设");
	for (const [key, [min, max]] of Object.entries({
		maxMessageLength: [1, 1e4],
		bubbleDelayMs: [0, 5e3],
		privateHistoryMaxTurns: [0, 100]
	})) if (values[key] !== void 0 && (!Number.isSafeInteger(values[key]) || Number(values[key]) < min || Number(values[key]) > max)) throw new AdminInputError("数值超出允许范围");
	resolveDSHConfig(values);
	return values;
};
const projectGeneralSettings = (snapshot) => {
	const app = JSON.parse(snapshot.source)["alemonjs-agent-link"] || {};
	const defaults = resolveDSHConfig();
	return {
		revision: snapshot.revision,
		values: Object.fromEntries(generalFields.map((key) => [key, app[key] ?? defaults[key]])),
		customPromptConfigured: Boolean(app.defaultSystemPrompt),
		modulePersona: app.modules?.settings?.persona?.defaultId || ""
	};
};
const readGeneralSettings = async () => projectGeneralSettings(await getAdminStore().read());
const saveGeneralSettings = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string" || Object.keys(body).some((key) => !["revision", "values"].includes(key))) throw new AdminInputError("设置请求无效");
	const values = validateGeneralSettings(body.values);
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new AdminInputError("配置已变化，请刷新后重试");
	const source = JSON.parse(snapshot.source);
	const app = source["alemonjs-agent-link"] ||= {};
	const restart = values.transport !== void 0 && values.transport !== (app.transport || "qq-bot");
	if (values.aiEnabled === true && app.aiEnabled === false) app.aiNoticeEpoch = randomUUID();
	Object.assign(app, values);
	const saved = await store.save(JSON.stringify(source), body.revision);
	let message = restart ? "设置已保存；连接类型变更需要重启机器人后生效" : "设置已保存并重新加载";
	try {
		getConfig().reload();
	} catch {
		message = "设置已保存，但重新加载失败，请重启机器人后核对";
	}
	return {
		data: projectGeneralSettings(saved),
		message,
		restartRequired: restart
	};
};

export { generalFields, projectGeneralSettings, readGeneralSettings, saveGeneralSettings, validateGeneralSettings };