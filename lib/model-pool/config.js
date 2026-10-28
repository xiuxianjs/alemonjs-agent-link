// src/model-pool/config.ts
const idPattern = /^[a-z][a-z0-9-]{0,39}$/u;
const purposes = /* @__PURE__ */ new Set([
	"chat",
	"tools",
	"vision",
	"replyGate"
]);
const strategies = /* @__PURE__ */ new Set([
	"weighted-round-robin",
	"least-busy",
	"sticky"
]);
const defaultRetryStatuses = [
	401,
	402,
	403,
	429,
	500,
	502,
	503,
	504
];
const text = (value, name, max) => {
	if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) throw new Error(`modelPool ${name} 无效。`);
	return value.trim();
};
const integer = (value, name, min, max) => {
	if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`modelPool ${name} 需要 ${min}–${max} 的整数。`);
	return Number(value);
};
const httpsUrl = (value, name) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`modelPool ${name} 不是有效 URL。`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(`modelPool ${name} 需要不含凭证、查询参数的 HTTPS 地址。`);
	return value.replace(/\/+$/u, "");
};
const endpointKey = (raw) => {
	const direct = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
	const envName = typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv.trim() : "";
	if (direct && envName) throw new Error("modelPool 端点不能同时配置 apiKey 和 apiKeyEnv。");
	if (envName) {
		const value = process.env[envName];
		if (!value) throw new Error(`modelPool 端点 ${String(raw.id || "")} 的 apiKeyEnv ${envName} 未设置。`);
		return value.trim();
	}
	return direct;
};
const parseModelPool = (raw, defaults) => {
	if (raw === void 0 || raw === null || raw === false) return void 0;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("modelPool 需要为对象。");
	const value = raw;
	if (value.enabled === false) return void 0;
	if (value.enabled !== void 0 && typeof value.enabled !== "boolean") throw new Error("modelPool.enabled 需要为布尔值。");
	if (!Array.isArray(value.endpoints) || value.endpoints.length === 0) return void 0;
	if (value.endpoints.length > 20) throw new Error("modelPool.endpoints 最多 20 个。");
	const ids = /* @__PURE__ */ new Set();
	const endpoints = value.endpoints.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`modelPool.endpoints[${index}] 需要为对象。`);
		const item = entry;
		const id = text(item.id, `endpoints[${index}].id`, 40);
		if (!idPattern.test(id) || ids.has(id)) throw new Error(`modelPool 端点 id 无效或重复：${id}`);
		ids.add(id);
		const provider = item.provider === void 0 ? defaults.provider : text(item.provider, `endpoints[${index}].provider`, 80);
		const fallbackBase = defaults.baseUrl || (provider === "deepseek-official" ? "https://api.deepseek.com" : "");
		const baseUrl = httpsUrl(item.baseUrl === void 0 ? fallbackBase : text(item.baseUrl, `endpoints[${index}].baseUrl`, 500), `endpoints[${index}].baseUrl`);
		const apiKey = endpointKey(item);
		const model = text(item.model === void 0 ? defaults.model : item.model, `endpoints[${index}].model`, 200);
		const weight = item.weight === void 0 ? 1 : integer(item.weight, `endpoints[${index}].weight`, 1, 100);
		const maxConcurrent = item.maxConcurrent === void 0 ? 2 : integer(item.maxConcurrent, `endpoints[${index}].maxConcurrent`, 1, 100);
		const capabilities = item.capabilities === void 0 ? [
			"chat",
			"tools",
			"replyGate"
		] : item.capabilities;
		if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.length > purposes.size || capabilities.some((capability) => typeof capability !== "string" || !purposes.has(capability))) throw new Error(`modelPool.endpoints[${index}].capabilities 无效。`);
		if (typeof item.enabled !== "undefined" && typeof item.enabled !== "boolean") throw new Error(`modelPool.endpoints[${index}].enabled 需要为布尔值。`);
		if (!apiKey || apiKey.length < 8 || apiKey.length > 500) throw new Error(`modelPool 端点 ${id} 的 apiKey 无效。`);
		return {
			id,
			provider,
			baseUrl,
			apiKey,
			model,
			weight,
			maxConcurrent,
			capabilities: [...new Set(capabilities)],
			enabled: item.enabled !== false
		};
	});
	const strategy = value.strategy === void 0 ? "weighted-round-robin" : value.strategy;
	if (typeof strategy !== "string" || !strategies.has(strategy)) throw new Error("modelPool.strategy 无效。");
	const retryStatuses = value.retryStatuses === void 0 ? defaultRetryStatuses : value.retryStatuses;
	if (!Array.isArray(retryStatuses) || retryStatuses.length > 20 || retryStatuses.some((status) => !Number.isSafeInteger(status) || status < 100 || status > 599)) throw new Error("modelPool.retryStatuses 无效。");
	return {
		enabled: true,
		strategy,
		maxAttempts: value.maxAttempts === void 0 ? 3 : integer(value.maxAttempts, "maxAttempts", 1, 5),
		failureThreshold: value.failureThreshold === void 0 ? 2 : integer(value.failureThreshold, "failureThreshold", 1, 10),
		cooldownSeconds: value.cooldownSeconds === void 0 ? 60 : integer(value.cooldownSeconds, "cooldownSeconds", 1, 86400),
		retryStatuses: [...new Set(retryStatuses)],
		endpoints
	};
};
const modelPoolFingerprint = (pool) => pool ? JSON.stringify(pool) : "";

export { modelPoolFingerprint, parseModelPool };