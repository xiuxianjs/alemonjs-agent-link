// src/model-pool/balance.ts
const CACHE_TTL_MS = 6e4;
const cache = /* @__PURE__ */ new Map();
const numberValue = (value) => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
};
const money = (amount, currency = "CNY") => `${currency === "CNY" ? "¥" : `${currency} `}${amount.toFixed(2)}`;
const deepSeekBalance = async (endpoint, signal) => {
	const base = endpoint.baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	const response = await fetch(`${base}/user/balance`, {
		headers: {
			Authorization: `Bearer ${endpoint.apiKey}`,
			Accept: "application/json"
		},
		redirect: "error",
		signal
	});
	if (!response.ok) return null;
	const payload = await response.json();
	const info = payload.balance_infos?.find((item) => item.currency === "CNY") || payload.balance_infos?.[0];
	const amount = numberValue(info?.total_balance);
	if (amount === void 0) return null;
	return {
		text: payload.is_available === false ? `不可用（${money(amount, typeof info?.currency === "string" ? info.currency : "CNY")}）` : money(amount, typeof info?.currency === "string" ? info.currency : "CNY"),
		amount,
		currency: typeof info?.currency === "string" ? info.currency : "CNY",
		checkedAt: Date.now()
	};
};
const newApiBalance = async (endpoint, signal) => {
	const base = endpoint.baseUrl.replace(/\/+$/u, "");
	const headers = {
		Authorization: `Bearer ${endpoint.apiKey}`,
		Accept: "application/json"
	};
	const usage = await fetch(`${base}/dashboard/billing/usage`, {
		headers,
		redirect: "error",
		signal
	});
	if (!usage.ok) return null;
	const payload = await usage.json();
	const cents = numberValue(payload.total_usage);
	if (cents === void 0) return null;
	const used = Math.max(0, cents / 100);
	return {
		text: `已用 ¥${used.toFixed(2)}`,
		used,
		currency: "CNY",
		checkedAt: Date.now()
	};
};
const templateBalance = async (endpoint, template, signal) => {
	const url = template.replaceAll("{key}", encodeURIComponent(endpoint.apiKey));
	const response = await fetch(url, {
		headers: { Accept: "application/json" },
		redirect: "error",
		signal
	});
	if (response.status === 404) return {
		text: "未收录",
		checkedAt: Date.now()
	};
	if (!response.ok) return {
		text: `查询失败 HTTP ${response.status}`,
		checkedAt: Date.now()
	};
	const payload = await response.json();
	if (payload.ok === false) return {
		text: "未收录",
		checkedAt: Date.now()
	};
	const data = payload.data && typeof payload.data === "object" ? payload.data : payload;
	const vouchers = Array.isArray(data.vouchers) ? data.vouchers : [];
	const voucherTotal = vouchers.reduce((sum, voucher) => {
		return sum + (numberValue((voucher && typeof voucher === "object" ? voucher : {}).available) || 0);
	}, 0);
	const amount = numberValue(data.total_available) ?? numberValue(data.balance) ?? (vouchers.length ? voucherTotal : void 0);
	if (amount === void 0) return {
		text: "无余额字段",
		checkedAt: Date.now()
	};
	return {
		text: money(amount),
		amount,
		currency: "CNY",
		checkedAt: Date.now()
	};
};
const fetchOne = async (config, endpoint) => {
	const template = endpoint.balanceUrl || config.balanceUrls?.[endpoint.provider] || (endpoint.provider === "sensenova" ? void 0 : config.balanceUrl);
	const style = endpoint.balanceStyle || config.balanceStyle;
	const cacheKey = `${endpoint.id}:${endpoint.apiKey.slice(-6)}:${style || ""}:${template || ""}`;
	const cached = cache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 6e3);
	timer.unref?.();
	try {
		let result = null;
		if (endpoint.provider === "deepseek-official" && /(^|\.)api\.deepseek\.com$/u.test(new URL(endpoint.baseUrl).hostname)) result = await deepSeekBalance(endpoint, controller.signal);
		if (!result && style === "newapi") result = await newApiBalance(endpoint, controller.signal);
		if (!result && template) result = await templateBalance(endpoint, template, controller.signal);
		if (!result && endpoint.provider === "sensenova") result = {
			text: "免费/限流",
			checkedAt: Date.now()
		};
		if (!result) result = {
			text: "无余额接口",
			checkedAt: Date.now()
		};
		cache.set(cacheKey, {
			...result,
			expiresAt: Date.now() + CACHE_TTL_MS
		});
		return result;
	} catch {
		return {
			text: "查询失败",
			checkedAt: Date.now()
		};
	} finally {
		clearTimeout(timer);
	}
};
const fetchPoolBalances = async (config) => {
	const rows = await Promise.all(config.endpoints.map(async (endpoint) => [endpoint.id, await fetchOne(config, endpoint)]));
	return new Map(rows);
};
const clearBalanceCache = () => cache.clear();

export { clearBalanceCache, fetchPoolBalances };