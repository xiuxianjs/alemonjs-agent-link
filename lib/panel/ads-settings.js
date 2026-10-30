import { parseAds } from "../ads/config.js";
import { getAdminStore } from "./admin-panel.js";
import { getConfig } from "alemonjs";

// src/panel/ads-settings.ts
const readAdsSettings = async () => {
	const snapshot = await getAdminStore().read();
	return {
		revision: snapshot.revision,
		...parseAds(JSON.parse(snapshot.source)["alemonjs-agent-link"]?.ads)
	};
};
const saveAdsSettings = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string" || Object.keys(body).some((key) => ![
		"revision",
		"enabled",
		"items"
	].includes(key))) throw new Error("广告设置无效");
	const ads = parseAds({
		enabled: body.enabled,
		items: body.items
	});
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化");
	const source = JSON.parse(snapshot.source);
	source["alemonjs-agent-link"].ads = ads;
	await store.save(JSON.stringify(source), body.revision);
	getConfig().reload();
	return readAdsSettings();
};

export { readAdsSettings, saveAdsSettings };