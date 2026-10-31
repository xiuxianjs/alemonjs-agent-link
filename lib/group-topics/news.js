import { createHash } from "node:crypto";

// src/group-topics/news.ts
const recentNewsDay = (publishedAt, now = Date.now()) => {
	const day = (time) => Math.floor((time + 288e5) / 864e5);
	return Number.isFinite(publishedAt) && publishedAt <= now && day(now) - day(publishedAt) >= 0 && day(now) - day(publishedAt) <= 1;
};
/** Administrator-supplied metadata; fetching and verification remain a separate ingestion stage. */
const newsCandidate = (urlText, date, tags, summary, now = Date.now()) => {
	const url = new URL(urlText);
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("来源必须是 HTTPS 新闻原文链接");
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("发布日期格式为 YYYY-MM-DD");
	const publishedAt = Date.parse(`${date}T00:00:00+08:00`);
	if (!Number.isFinite(publishedAt) || new Date(publishedAt + 288e5).toISOString().slice(0, 10) !== date || !recentNewsDay(publishedAt, now)) throw new Error("只接受上海时区今天或昨天的发布日期");
	url.hash = "";
	for (const key of [...url.searchParams.keys()]) if (key.startsWith("utm_")) url.searchParams.delete(key);
	url.searchParams.sort();
	if (!tags.length || !summary.trim() || summary.length > 1200) throw new Error("请填写主题标签与不超过 1200 字的事实摘要");
	return {
		id: createHash("sha256").update(url.href).digest("hex"),
		origin: "news",
		sourceUrl: url.href,
		summary,
		tags,
		publishedAt,
		expiresAt: publishedAt + 1728e5,
		approved: true
	};
};

export { newsCandidate, recentNewsDay };