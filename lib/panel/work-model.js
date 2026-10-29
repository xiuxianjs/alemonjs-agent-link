import { getDSHConfig } from "../dsh/runtime-config.js";
import { requestModelMessage } from "../agent/tool-chat.js";
import { getAdminStore } from "./admin-panel.js";
import { getAppConfig, getConfig } from "alemonjs";

// src/panel/work-model.ts
const validateWorkModel = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请配置工作模型");
	const data = value;
	if (Object.keys(data).some((key) => ![
		"baseUrl",
		"apiKey",
		"model"
	].includes(key))) throw new Error("不支持的工作模型字段");
	for (const key of [
		"baseUrl",
		"apiKey",
		"model"
	]) if (typeof data[key] !== "string" || !data[key].trim() || data[key].length > 2e3) throw new Error("请填写有效的地址、API Key 和模型");
	const url = new URL(data.baseUrl);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("工作模型地址必须为不含凭证和查询参数的 HTTPS 地址");
	return {
		baseUrl: data.baseUrl.trim().replace(/\/+$/, ""),
		apiKey: data.apiKey.trim(),
		model: data.model.trim()
	};
};
const project = (snapshot) => ({
	revision: snapshot.revision,
	values: JSON.parse(snapshot.source)["alemonjs-agent-link"]?.workModel || {}
});
const readWorkModel = async () => project(await getAdminStore().read());
const saveWorkModel = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string") throw new Error("无效的工作模型配置");
	const values = validateWorkModel(body.values);
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化，请刷新后重试");
	const source = JSON.parse(snapshot.source);
	(source["alemonjs-agent-link"] ||= {}).workModel = values;
	const saved = await store.save(JSON.stringify(source), body.revision);
	getConfig().reload();
	return project(saved);
};
const requestWorkModel = async (instruction, text) => {
	if (typeof text !== "string" || !text.trim() || text.length > 2e4) throw new Error("请输入 1～20000 字的文本");
	const credentials = validateWorkModel(getAppConfig().value.workModel);
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