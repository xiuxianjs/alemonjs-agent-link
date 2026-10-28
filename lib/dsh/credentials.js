import { getCredentialPool } from "../credentials/pool.js";
import { getAppConfigValue } from "alemonjs";

// src/dsh/credentials.ts
const managedByConfigMessage = "模型凭证由 alemon.config.yaml 管理，保存配置后，后续请求自动使用新配置，无需重启机器人。";
const getDSHCredentials = (config = getAppConfigValue(), options = {}) => {
	try {
		const pool = getCredentialPool(config);
		if (pool) return Promise.resolve(pool.select({
			stable: true,
			...options,
			reserve: options.reserve === true
		}));
	} catch {}
	const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
	if (!apiKey) return Promise.resolve(null);
	return Promise.resolve({
		apiKey,
		baseUrl: typeof config?.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : void 0,
		...typeof config?.model === "string" && config.model.trim() ? { model: config.model.trim() } : {}
	});
};
const saveDSHCredentials = (_credentials) => Promise.reject(/* @__PURE__ */ new Error(managedByConfigMessage));
const removeDSHCredentials = () => Promise.reject(/* @__PURE__ */ new Error(managedByConfigMessage));
const getChatCredentials = async (options = {}) => {
	const { getBoundCredential } = await import("../credentials/scoped.js");
	const personal = await getBoundCredential();
	return personal ? {
		apiKey: personal.apiKey,
		baseUrl: "https://api.deepseek.com",
		scoped: true,
		personal: personal.scope.channelId.startsWith("private:")
	} : getDSHCredentials(void 0, {
		purpose: options.purpose || "chat",
		stickyKey: options.stickyKey,
		reserve: true,
		stable: false
	});
};

export { getChatCredentials, getDSHCredentials, removeDSHCredentials, saveDSHCredentials };