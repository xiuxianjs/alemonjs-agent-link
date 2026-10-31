import { recentNewsDay } from "./news.js";
import { getGroupTopicStore } from "./store.js";
import { biliOptions, createBiliClient } from "../bili/client.js";

// src/group-topics/collect.ts
const videoTopicCandidates = (items, tags, now = Date.now()) => items.flatMap((item) => {
	if (!/^BV[0-9A-Za-z]{10}$/u.test(item.bvid) || !recentNewsDay(item.publishedAt ?? NaN, now)) return [];
	const metadata = `${item.title}\n${item.description}`.toLowerCase();
	const matched = tags.filter((tag) => tag.trim() && metadata.includes(tag.toLowerCase()));
	if (!matched.length) return [];
	const publishedAt = item.publishedAt;
	const dayStart = Math.floor((publishedAt + 288e5) / 864e5) * 864e5 - 288e5;
	return [{
		id: `bili:${item.bvid}`,
		origin: "public-video",
		summary: `公开视频标题：${item.title.slice(0, 300)}。仅有搜索元数据，未观看或核实视频观点。`,
		tags: matched,
		sourceUrl: `https://www.bilibili.com/video/${item.bvid}`,
		publishedAt,
		expiresAt: dayStart + 1728e5,
		approved: true
	}];
});
const running = /* @__PURE__ */ new Set();
const collectGroupVideoTopics = async (config, groupId) => {
	if (config.aiEnabled === false || config.modules?.disabled?.includes("bili")) throw new Error("联网话题采集已停用");
	const store = getGroupTopicStore(config);
	const profile = store.profile(groupId);
	if (!profile?.enabled || !profile.tags.length) throw new Error("请先配置并开启群话题档案");
	if (running.has(groupId) || running.size >= 2) throw new Error("话题采集正在进行，请稍后查看候选");
	running.add(groupId);
	try {
		const client = createBiliClient(biliOptions(config.modules?.settings?.bili || {}));
		const keyword = profile.tags[Math.floor(Date.now() / 36e5) % profile.tags.length];
		const result = await client.search(keyword, AbortSignal.timeout(15e3));
		const current = store.profile(groupId);
		if (!current?.enabled || JSON.stringify(current) !== JSON.stringify(profile)) return 0;
		let added = 0;
		let blocked = 0;
		let duplicate = 0;
		const invalidDate = result.items.filter((item) => !recentNewsDay(item.publishedAt ?? NaN)).length;
		const candidates = videoTopicCandidates(result.items, profile.tags);
		for (const topic of candidates) {
			if (topic.tags.some((tag) => profile.blockedTags.includes(tag))) {
				blocked++;
				continue;
			}
			if (store.addTopic(topic)) added++;
			else duplicate++;
		}
		store.recordRun(groupId, "filter", `主题「${keyword}」搜索${result.items.length}，日期缺失或过期${invalidDate}，主题不匹配${result.items.length - invalidDate - candidates.length}，禁忌${blocked}，重复${duplicate}，入库${added}`);
		return added;
	} finally {
		running.delete(groupId);
	}
};

export { collectGroupVideoTopics, videoTopicCandidates };