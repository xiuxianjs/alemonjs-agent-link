import { getCredentialPool } from "../credentials/pool.js";
import { getAppConfigValue } from "alemonjs";
import { setTimeout } from "node:timers/promises";

// src/dsh/credentials.ts
const managedByConfigMessage = "模型凭证由 alemon.config.yaml 管理，保存配置后，后续请求自动使用新配置，无需重启机器人。";
const legacyCredentials = (config) => {
	const apiKey = typeof config?.apiKey === "string" ? config.apiKey.trim() : "";
	if (!apiKey) return null;
	return {
		apiKey,
		baseUrl: typeof config?.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : void 0,
		...typeof config?.model === "string" && config.model.trim() ? { model: config.model.trim() } : {}
	};
};
const getDSHCredentials = (config = getAppConfigValue(), options = {}) => {
	try {
		const pool = getCredentialPool(config);
		if (pool) return Promise.resolve(pool.select({
			...options,
			reserve: options.reserve === true
		}));
	} catch {}
	return Promise.resolve(legacyCredentials(config));
};
/** Dedicated workspace endpoint for agent_workspace; falls back to the
* sandbox credential when no endpoint is explicitly marked as workspace. */
const getWorkspaceCredentials = (options = {}) => {
	const config = getAppConfigValue();
	try {
		const selected = getCredentialPool(config)?.select({
			purpose: "chat",
			stickyKey: options.stickyKey,
			stable: false,
			reserve: false,
			workspaceOnly: true
		});
		if (selected) return Promise.resolve(selected);
	} catch {}
	return getSandboxCredentials();
};
/** Sandbox workers speak the deepseek-official Messages protocol. Prefer a
* matching pooled endpoint, then fall back to the legacy DeepSeek key. */
const getSandboxCredentials = () => {
	const config = getAppConfigValue();
	const provider = typeof config.provider === "string" && config.provider.trim() ? config.provider.trim() : "deepseek-official";
	try {
		const selected = getCredentialPool(config)?.select({
			purpose: "chat",
			stable: true,
			reserve: false,
			provider
		});
		if (selected) return Promise.resolve(selected);
	} catch {}
	return Promise.resolve(legacyCredentials(config));
};
const saveDSHCredentials = (_credentials) => Promise.reject(/* @__PURE__ */ new Error(managedByConfigMessage));
const removeDSHCredentials = () => Promise.reject(/* @__PURE__ */ new Error(managedByConfigMessage));
const getChatCredentials = async (options = {}) => {
	const { getBoundCredential } = await import("../credentials/scoped.js");
	const personal = await getBoundCredential();
	if (personal) return {
		apiKey: personal.apiKey,
		baseUrl: "https://api.deepseek.com",
		scoped: true,
		personal: personal.scope.channelId.startsWith("private:")
	};
	const config = getAppConfigValue();
	const waitMs = getCredentialPool(config)?.config.queueMaxWaitMs ?? 0;
	const deadline = Date.now() + waitMs;
	for (;;) {
		const credentials = await getDSHCredentials(void 0, {
			purpose: options.purpose || "chat",
			stickyKey: options.stickyKey,
			reserve: true,
			stable: false,
			estimatedTokens: options.estimatedTokens,
			waitForCapacity: true
		});
		if (credentials || waitMs <= 0 || Date.now() >= deadline) return credentials;
		await setTimeout(50);
	}
};

export { getChatCredentials, getDSHCredentials, getSandboxCredentials, getWorkspaceCredentials, removeDSHCredentials, saveDSHCredentials };