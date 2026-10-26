import { getConfigValue } from "alemonjs";

// src/dsh/credentials.ts
const managedByConfigMessage = "模型凭证由 alemon.config.yaml 管理，请修改配置后重启服务。";
const getDSHCredentials = (value = getConfigValue()) => {
	const config = value?.["alemonjs-agent-link"];
	const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
	if (!apiKey) return Promise.resolve(null);
	return Promise.resolve({
		apiKey,
		baseUrl: typeof config?.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : void 0
	});
};
const saveDSHCredentials = (_credentials) => Promise.reject(/* @__PURE__ */ new Error(managedByConfigMessage));
const removeDSHCredentials = () => Promise.reject(/* @__PURE__ */ new Error(managedByConfigMessage));

export { getDSHCredentials, removeDSHCredentials, saveDSHCredentials };