import { parseModelPool } from "../model-pool/config.js";
import { getAdminStore } from "./admin-panel.js";
import { getConfig } from "alemonjs";

// src/panel/pool-settings.ts
const root = "alemonjs-agent-link";
const fields = {
	endpoint: [
		"id",
		"provider",
		"baseUrl",
		"apiKey",
		"model",
		"account",
		"capabilities",
		"enabled",
		"fallback",
		"priority",
		"weight",
		"maxConcurrent",
		"rpm",
		"tpm",
		"balanceStyle",
		"balanceUrl"
	],
	rules: [
		"enabled",
		"strategy",
		"maxAttempts",
		"failureThreshold",
		"cooldownSeconds",
		"queueMaxWaitMs",
		"retryBudgetMs",
		"balanceAlertYuan"
	],
	reorder: ["ids"],
	budget: [
		"enabled",
		"globalDailyYuan",
		"personalDailyYuan",
		"replyGateDailyYuan",
		"replyGateGlobalDailyYuan",
		"maxOutputTokens"
	]
};
const editablePool = (app) => {
	const original = app.modelPool;
	if (!original || original === false) return {};
	const raw = Array.isArray(original) ? { keys: original } : original;
	const provider = app.provider || "deepseek-official";
	const normalized = parseModelPool({
		...raw,
		enabled: true
	}, {
		provider,
		baseUrl: app.baseUrl || (provider === "deepseek-official" ? "https://api.deepseek.com" : void 0),
		model: app.model || "deepseek-v4-flash",
		apiKey: app.apiKey
	});
	const { keys: _keys, ...settings } = raw;
	return {
		...settings,
		endpoints: normalized?.endpoints || []
	};
};
const project = (snapshot) => {
	const app = JSON.parse(snapshot.source)[root] || {};
	return {
		revision: snapshot.revision,
		modelPool: editablePool(app),
		budget: app.budget || {},
		baseUrl: app.baseUrl
	};
};
/** Product-scoped interface: never return or accept a whole application configuration. */
const readPoolSettings = async () => project(await getAdminStore().read());
const updatePoolSettings = async (input) => {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("无效的轮转操作");
	const body = input;
	if (Object.keys(body).some((key) => ![
		"revision",
		"action",
		"id",
		"values"
	].includes(key))) throw new Error("不支持的轮转字段");
	if (typeof body.revision !== "string" || ![
		"endpoint",
		"rules",
		"budget",
		"remove",
		"reorder"
	].includes(body.action || "")) throw new Error("无效的轮转操作");
	if (body.id !== void 0 && typeof body.id !== "string") throw new Error("无效的端点");
	if (body.action !== "remove") {
		if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) throw new Error("无效的轮转内容");
		const allowed = fields[body.action];
		if (Object.keys(body.values).some((key) => !allowed.includes(key))) throw new Error("不支持的轮转字段");
	}
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化，请刷新后重试");
	const source = JSON.parse(snapshot.source);
	const app = source[root];
	if (body.action !== "budget") app.modelPool = editablePool(app);
	const patch = (target) => {
		for (const [key, value] of Object.entries(body.values || {})) if (value === null || value === "") Reflect.deleteProperty(target, key);
		else target[key] = value;
		return target;
	};
	if (body.action === "reorder") {
		const entries = app.modelPool.endpoints || [];
		const ids = body.values?.ids;
		if (!Array.isArray(ids) || ids.length !== entries.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !entries.some((entry) => entry.id === id))) throw new Error("排序必须包含全部端点且不能重复");
		app.modelPool.endpoints = ids.map((id) => entries.find((entry) => entry.id === id));
	} else if (body.action === "endpoint" || body.action === "remove") {
		const pool = app.modelPool ||= {};
		const entries = pool.endpoints ||= [];
		if (!Array.isArray(entries)) throw new Error("端点数据不是有效列表");
		const index = entries.findIndex((entry) => entry.id === body.id);
		if (body.id !== void 0 && index < 0) throw new Error("端点不存在");
		if (body.action === "remove") {
			if (index < 0) throw new Error("端点不存在");
			entries.splice(index, 1);
		} else {
			const entry = patch(index < 0 ? {} : { ...entries[index] });
			if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/u.test(entry.id)) throw new Error("无效的端点编号");
			if (body.id !== void 0 && entry.id !== body.id) throw new Error("不能更改端点编号");
			if (entries.some((item, i) => item.id === entry.id && i !== index)) throw new Error("端点编号已存在");
			if (index < 0) entries.push(entry);
			else entries[index] = entry;
		}
	} else {
		const section = body.action === "rules" ? "modelPool" : "budget";
		app[section] = patch(app[section] || {});
	}
	if (body.action !== "budget") for (const entry of app.modelPool.endpoints || []) delete entry.priority;
	if (body.action !== "budget") editablePool(app);
	const saved = await store.save(JSON.stringify(source), body.revision);
	let message = "已保存";
	try {
		getConfig().reload();
	} catch {
		message = "已保存，运行状态尚未刷新，请联系部署人员重启后核对";
	}
	return {
		data: project(saved),
		message
	};
};

export { readPoolSettings, updatePoolSettings };