import { getAppConfigValue } from "alemonjs";

// src/ads/config.ts
const parseAds = (value = {}) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("广告配置无效");
	const raw = value;
	if (raw.enabled !== void 0 && typeof raw.enabled !== "boolean") throw new Error("广告开关无效");
	if (raw.items !== void 0 && (!Array.isArray(raw.items) || raw.items.length > 100)) throw new Error("广告最多100项");
	const ids = /* @__PURE__ */ new Set();
	const items = (raw.items || []).map((item) => {
		if (!item || !/^[a-zA-Z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id) || typeof item.title !== "string" || !item.title.trim() || item.title.length > 80 || typeof item.content !== "string" || !item.content.trim() || item.content.length > 1500 || typeof item.enabled !== "boolean" || !Number.isFinite(item.rewardYuan) || item.rewardYuan <= 0 || item.rewardYuan > 10 || Math.abs(item.rewardYuan * 100 - Math.round(item.rewardYuan * 100)) > 1e-6) throw new Error("广告字段无效：奖励为0.01–10元，最多两位小数");
		if (item.url) {
			const url = new URL(item.url);
			if (url.protocol !== "https:" || url.username || url.password) throw new Error("广告链接需要HTTPS");
		}
		ids.add(item.id);
		return {
			id: item.id,
			title: item.title,
			content: item.content,
			url: item.url,
			rewardYuan: item.rewardYuan,
			enabled: item.enabled
		};
	});
	return {
		enabled: raw.enabled === true,
		items
	};
};
const getAds = () => parseAds(getAppConfigValue().ads);

export { getAds, parseAds };