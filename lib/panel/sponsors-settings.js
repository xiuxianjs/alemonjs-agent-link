import { parseSponsors } from "../sponsors/config.js";
import { getAdminStore } from "./admin-panel.js";
import { getConfig } from "alemonjs";

// src/panel/sponsors-settings.ts
const readSponsorsSettings = async () => {
	const snapshot = await getAdminStore().read();
	return {
		revision: snapshot.revision,
		...parseSponsors(JSON.parse(snapshot.source)["alemonjs-agent-link"]?.sponsors)
	};
};
const saveSponsorsSettings = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string" || Object.keys(body).some((key) => ![
		"revision",
		"enabled",
		"items"
	].includes(key))) throw new Error("赞助列表设置无效");
	const sponsors = parseSponsors({
		enabled: body.enabled,
		items: body.items
	});
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化");
	const source = JSON.parse(snapshot.source);
	source["alemonjs-agent-link"].sponsors = sponsors;
	await store.save(JSON.stringify(source), body.revision);
	getConfig().reload();
	return readSponsorsSettings();
};

export { readSponsorsSettings, saveSponsorsSettings };