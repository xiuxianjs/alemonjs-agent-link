// src/bili/diary.ts
const readingDiary = (items, hours, now = Date.now()) => {
	return items.filter((item) => item.status === "active" && item.tags.includes("B站") && (item.origin === "event" && item.kind === "event" || item.origin === "diary" && item.kind === "diary") && item.createdAt >= now - hours * 36e5 && item.createdAt <= now).map((item) => {
		const type = item.origin === "diary" || item.tags.includes("阅读感想") ? "reflection" : "reading";
		let details = {};
		try {
			details = JSON.parse(item.text.slice(item.text.indexOf("{"), item.text.lastIndexOf("}") + 1));
		} catch {}
		const bvid = typeof details?.bvid === "string" && /^BV[0-9A-Za-z]{10}$/u.test(details.bvid) ? details.bvid : void 0;
		const title = typeof details?.title === "string" ? details.title.slice(0, 120) : void 0;
		const text = type === "reflection" && typeof details?.thought === "string" ? details.thought : item.text;
		const readings = (Array.isArray(details?.readings) ? details.readings : []).slice(0, 3).filter((row) => typeof row?.bvid === "string" && /^BV[0-9A-Za-z]{10}$/u.test(row.bvid)).map((row) => ({
			bvid: row.bvid,
			title: typeof row.title === "string" ? row.title.slice(0, 80) : ""
		}));
		const sourceReadingIds = item.tags.filter((tag) => /^reading:[a-f0-9]{12}$/u.test(tag)).map((tag) => tag.slice(8));
		return {
			id: item.id,
			at: item.createdAt,
			type,
			bvid,
			title,
			sourceReadingId: sourceReadingIds.length === 1 ? sourceReadingIds[0] : void 0,
			sourceReadingIds,
			readings,
			text
		};
	}).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
};
const formatReadingDiary = (entries, hours, timezone) => {
	if (!entries.length) return `最近 ${hours} 小时没有已保存的阅读记录，不代表从未浏览。`;
	const clean = (text) => text.replace(/\s+/gu, " ").trim();
	const lines = entries.slice(0, 5).map((item) => {
		return `${new Date(item.at).toLocaleString("zh-CN", {
			timeZone: timezone,
			hour12: false
		})} · ${item.type === "reflection" ? "想法" : "阅读"}\n${item.type === "reflection" ? clean(item.text).slice(0, 180) : item.title || clean(item.text).slice(0, 120)}${item.bvid ? `\n${item.bvid}` : ""}${item.readings?.length ? `\n${item.readings.map((row) => `${row.title} ${row.bvid}`).join("；")}` : ""}`;
	});
	return `最近 ${hours} 小时 · 展示 ${Math.min(5, entries.length)}/${entries.length} 条\n想法是当时生成的主观表达，不代表已发送。阅读记录不证明看过画面或听过声音。\n\n${lines.join("\n\n")}`;
};
/** Literal matching in saved evidence; a miss does not prove an event never occurred. */
const searchReadingDiary = (entries, query) => {
	const normalize = (text) => text.normalize("NFKC").toLowerCase();
	const keyword = normalize(query.trim());
	if (!keyword) return entries;
	return entries.map((entry, index) => {
		return {
			entry,
			index,
			score: normalize(entry.bvid || "").includes(keyword) || entry.readings?.some((row) => normalize(row.bvid).includes(keyword)) ? 3 : normalize(entry.title || "").includes(keyword) || entry.readings?.some((row) => normalize(row.title).includes(keyword)) ? 2 : normalize(entry.text).includes(keyword) ? 1 : 0
		};
	}).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map((row) => row.entry);
};
const readingContinuity = (items, topic, now = Date.now()) => {
	const diary = readingDiary(items, 168, now).filter((item) => item.type === "reflection");
	return searchReadingDiary(diary, topic).slice(0, 3).map((item) => ({
		id: item.id,
		recordedAt: new Date(item.at).toISOString(),
		thought: item.text.slice(0, 200),
		bvid: item.bvid
	}));
};

export { formatReadingDiary, readingContinuity, readingDiary, searchReadingDiary };