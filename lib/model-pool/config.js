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
	"balanced",
	"sticky"
]);
const defaultRetryStatuses = [
	401,
	402,
	403,
	404,
	405,
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
const balanceStyle = (raw, name) => {
	if (raw === void 0) return void 0;
	if (raw !== "newapi") throw new Error(`${name} 只支持 newapi。`);
	return raw;
};
const balanceConfig = (raw) => {
	if (raw === void 0) return {};
	if (typeof raw === "string") return { balanceUrl: balanceTemplate(raw, "modelPool.balanceUrl") };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("modelPool.balanceUrl 需要为 URL 字符串或按 provider 映射的对象。");
	const entries = Object.entries(raw);
	if (entries.length === 0 || entries.length > 20) throw new Error("modelPool.balanceUrl 的 provider 映射需要 1–20 项。");
	const balanceUrls = {};
	for (const [provider, value] of entries) {
		if (!provider.trim() || provider.length > 80) throw new Error("modelPool.balanceUrl 的 provider 名无效。");
		balanceUrls[provider] = balanceTemplate(value, `modelPool.balanceUrl.${provider}`);
	}
	return { balanceUrls };
};
const balanceTemplate = (raw, name) => {
	if (typeof raw !== "string" || !raw.trim() || raw.length > 1e3) throw new Error(`${name} 需要为 URL 字符串。`);
	const value = raw.trim();
	if (!value.includes("{key}")) throw new Error(`${name} 必须包含 {key} 占位符。`);
	let url;
	try {
		url = new URL(value.replaceAll("{key}", "sk-test-00000000"));
	} catch {
		throw new Error(`${name} 不是有效 URL。`);
	}
	if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${name} 需要不含凭证的 HTTPS 地址。`);
	return value;
};
const parsePricing = (raw, index) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`modelPool.endpoints[${index}].pricing 无效。`);
	const value = raw;
	const price = (key) => {
		const item = value[key];
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 1e5) throw new Error(`modelPool.endpoints[${index}].pricing.${key} 需要为非负数字。`);
		return item;
	};
	return {
		input: price("input"),
		output: price("output"),
		cached: value.cached === void 0 ? 0 : price("cached")
	};
};
const normalizeKeys = (raw) => {
	if (raw.keys === void 0) return void 0;
	if (raw.endpoints !== void 0) throw new Error("modelPool 不能同时配置 keys 和 endpoints。");
	if (!Array.isArray(raw.keys) || raw.keys.length === 0) return void 0;
	if (raw.keys.length > 20) throw new Error("modelPool.keys 最多 20 个。");
	const shared = {
		...raw.provider === void 0 ? {} : { provider: raw.provider },
		...raw.baseUrl === void 0 ? {} : { baseUrl: raw.baseUrl },
		...raw.model === void 0 ? {} : { model: raw.model }
	};
	return raw.keys.map((entry, index) => {
		if (typeof entry === "string") return {
			...shared,
			id: `key-${index + 1}`,
			apiKey: entry
		};
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`modelPool.keys[${index}] 需要为 Key 字符串或对象。`);
		const item = entry;
		const key = item.apiKey === void 0 ? item.key : item.apiKey;
		if (item.key !== void 0 && item.apiKey !== void 0) throw new Error(`modelPool.keys[${index}] 不能同时配置 key 和 apiKey。`);
		return {
			...shared,
			...item,
			...key === void 0 ? {} : { apiKey: key },
			...item.api === void 0 ? {} : { baseUrl: item.baseUrl === void 0 ? item.api : item.baseUrl },
			id: item.id === void 0 ? `key-${index + 1}` : item.id
		};
	});
};
const parseModelPool = (raw, defaults) => {
	if (raw === void 0 || raw === null || raw === false) return void 0;
	if (Array.isArray(raw)) raw = { keys: raw };
	if (!raw || typeof raw !== "object") throw new Error("modelPool 需要为对象或 Key 数组。");
	const value = raw;
	if (value.enabled === false) return void 0;
	if (value.enabled !== void 0 && typeof value.enabled !== "boolean") throw new Error("modelPool.enabled 需要为布尔值。");
	if (value.probeChat !== void 0 && typeof value.probeChat !== "boolean") throw new Error("modelPool.probeChat 需要为布尔值。");
	if (value.capabilityProbe !== void 0 && typeof value.capabilityProbe !== "boolean") throw new Error("modelPool.capabilityProbe 需要为布尔值。");
	const keys = normalizeKeys(value);
	const source = keys === void 0 ? value.endpoints : keys;
	if (!Array.isArray(source) || source.length === 0) return void 0;
	if (source.length > 20) throw new Error("modelPool.endpoints 最多 20 个。");
	const ids = /* @__PURE__ */ new Set();
	const endpoints = source.map((entry, index) => {
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
		const pricing = item.pricing === void 0 ? void 0 : parsePricing(item.pricing, index);
		if (item.fallback !== void 0 && typeof item.fallback !== "boolean") throw new Error(`modelPool.endpoints[${index}].fallback 需要为布尔值。`);
		const priority = item.priority === void 0 ? 0 : integer(item.priority, `endpoints[${index}].priority`, 0, 100);
		const endpointBalanceStyle = balanceStyle(item.balanceStyle, `endpoints[${index}].balanceStyle`);
		const account = item.account === void 0 ? void 0 : text(item.account, `endpoints[${index}].account`, 80);
		if (item.workspace !== void 0 && typeof item.workspace !== "boolean") throw new Error(`modelPool.endpoints[${index}].workspace 需要为布尔值。`);
		const rpm = item.rpm === void 0 ? void 0 : integer(item.rpm, `endpoints[${index}].rpm`, 1, 1e6);
		const tpm = item.tpm === void 0 ? void 0 : integer(item.tpm, `endpoints[${index}].tpm`, 1, 1e9);
		const balanceUrl = item.balanceUrl === void 0 ? void 0 : balanceTemplate(item.balanceUrl, `endpoints[${index}].balanceUrl`);
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
			...pricing ? { pricing } : {},
			...item.fallback === true ? { fallback: true } : {},
			priority,
			...endpointBalanceStyle ? { balanceStyle: endpointBalanceStyle } : {},
			...account ? { account } : {},
			...item.workspace === true ? { workspace: true } : {},
			...rpm ? { rpm } : {},
			...tpm ? { tpm } : {},
			...balanceUrl ? { balanceUrl } : {},
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
	const balance = balanceConfig(value.balanceUrl === void 0 ? value.balanceUrls : value.balanceUrl);
	const poolBalanceStyle = balanceStyle(value.balanceStyle, "modelPool.balanceStyle");
	return {
		enabled: true,
		strategy,
		maxAttempts: value.maxAttempts === void 0 ? 3 : integer(value.maxAttempts, "maxAttempts", 1, 20),
		failureThreshold: value.failureThreshold === void 0 ? 2 : integer(value.failureThreshold, "failureThreshold", 1, 10),
		cooldownSeconds: value.cooldownSeconds === void 0 ? 60 : integer(value.cooldownSeconds, "cooldownSeconds", 1, 86400),
		retryStatuses: [...new Set(retryStatuses)],
		probeIntervalSeconds: value.probeIntervalSeconds === void 0 ? 60 : integer(value.probeIntervalSeconds, "probeIntervalSeconds", 0, 3600),
		probeTimeoutMs: value.probeTimeoutMs === void 0 ? 5e3 : integer(value.probeTimeoutMs, "probeTimeoutMs", 1e3, 3e4),
		probeChat: value.probeChat === void 0 ? true : value.probeChat === true,
		capabilityProbe: value.capabilityProbe === true,
		capabilityProbeTimeoutMs: value.capabilityProbeTimeoutMs === void 0 ? 6e4 : integer(value.capabilityProbeTimeoutMs, "capabilityProbeTimeoutMs", 5e3, 12e4),
		recoveryProbeSeconds: value.recoveryProbeSeconds === void 0 ? 300 : integer(value.recoveryProbeSeconds, "recoveryProbeSeconds", 0, 86400),
		stickySeconds: value.stickySeconds === void 0 ? 1800 : integer(value.stickySeconds, "stickySeconds", 0, 86400),
		balanceWindowSeconds: value.balanceWindowSeconds === void 0 ? 300 : integer(value.balanceWindowSeconds, "balanceWindowSeconds", 0, 86400),
		retryBudgetMs: value.retryBudgetMs === void 0 ? 12e3 : integer(value.retryBudgetMs, "retryBudgetMs", 1e3, 3e5),
		retryJitterMs: value.retryJitterMs === void 0 ? 200 : integer(value.retryJitterMs, "retryJitterMs", 0, 5e3),
		queueMaxWaitMs: value.queueMaxWaitMs === void 0 ? 0 : integer(value.queueMaxWaitMs, "queueMaxWaitMs", 0, 3e4),
		...balance,
		...poolBalanceStyle ? { balanceStyle: poolBalanceStyle } : {},
		balanceAlertYuan: value.balanceAlertYuan === void 0 ? 5 : integer(value.balanceAlertYuan, "balanceAlertYuan", 0, 1e6),
		endpoints
	};
};
const modelPoolFingerprint = (pool) => pool ? JSON.stringify(pool) : "";

export { modelPoolFingerprint, parseModelPool };