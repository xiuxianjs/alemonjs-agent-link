import { requestModelMessage } from "../agent/tool-chat.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { getAdminStore } from "./admin-panel.js";
import { getAppConfig, getConfig } from "alemonjs";

// src/panel/work-model.ts
const fields = [
	"baseUrl",
	"apiKey",
	"model",
	"provider"
];
const validateWorkModel = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请配置工作模型");
	const data = value;
	if (Object.keys(data).some((key) => !fields.includes(key))) throw new Error("不支持的工作模型字段");
	for (const key of fields) if (data[key] !== void 0 && (typeof data[key] !== "string" || data[key].length > 2e3)) throw new Error("工作模型字段必须为有效文本");
	const config = getDSHConfig(data);
	const provider = config.provider;
	const baseUrl = (typeof data.baseUrl === "string" ? data.baseUrl.trim() : "") || (provider === "deepseek-official" ? "https://api.deepseek.com" : "");
	if (!baseUrl) throw new Error("非 DeepSeek 官方提供方必须填写接口地址");
	const url = new URL(baseUrl);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("工作模型地址必须为不含凭证和查询参数的 HTTPS 地址");
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey: typeof data.apiKey === "string" ? data.apiKey.trim() : "",
		model: config.model,
		provider
	};
};
const project = (snapshot) => {
	const app = JSON.parse(snapshot.source)["alemonjs-agent-link"] || {};
	const config = getDSHConfig(app);
	return {
		revision: snapshot.revision,
		values: {
			apiKey: app.apiKey || "",
			baseUrl: app.baseUrl || "",
			model: config.model,
			provider: config.provider
		}
	};
};
const readWorkModel = async () => project(await getAdminStore().read());
const saveWorkModel = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string") throw new Error("无效的工作模型配置");
	const values = validateWorkModel(body.values);
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化，请刷新后重试");
	const source = JSON.parse(snapshot.source);
	const app = source["alemonjs-agent-link"] ||= {};
	Object.assign(app, values);
	if (!body.values.baseUrl) delete app.baseUrl;
	delete app.workModel;
	const saved = await store.save(JSON.stringify(source), body.revision);
	getConfig().reload();
	return project(saved);
};
const requestWorkModel = async (instruction, text) => {
	if (typeof text !== "string" || !text.trim() || text.length > 2e4) throw new Error("请输入 1～20000 字的文本");
	const app = getAppConfig().value;
	const credentials = validateWorkModel(Object.fromEntries(fields.map((key) => [key, app[key]])));
	if (!credentials.apiKey) throw new Error("请先在工作模型中配置 API Key");
	const config = getDSHConfig();
	const result = await requestModelMessage({
		...config,
		budget: {
			...config.budget,
			enabled: false
		}
	}, credentials, [{
		role: "system",
		content: instruction
	}, {
		role: "user",
		content: text
	}], [], AbortSignal.timeout(3e4), void 0, { sensitiveInput: true });
	if (!result.content?.trim()) throw new Error("工作模型未返回文本");
	return result.content;
};

export { readWorkModel, requestWorkModel, saveWorkModel, validateWorkModel };