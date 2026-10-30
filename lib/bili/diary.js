import { visualCropRequest } from "./crop.js";

// src/bili/diary.ts
const readingDetails = (item) => {
	try {
		const value = JSON.parse(item.text.slice(item.text.indexOf("{"), item.text.lastIndexOf("}") + 1));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	} catch {
		return {};
	}
};
const isReading = (item) => item.status === "active" && item.origin === "event" && item.kind === "event" && item.tags.includes("B站") && !item.tags.includes("阅读感想");
const sourceEvidence = (id, source) => {
	const details = source ? readingDetails(source) : {};
	const times = details.sampledTimestamps;
	let crop;
	try {
		crop = visualCropRequest(details.visualCrop);
	} catch {}
	const visual = details.visualStatus === "available" && (details.visualRegion !== "crop" || Boolean(crop)) && (crop === void 0 || details.visualRegion === "crop") && Array.isArray(times) && times.length > 0 && times.length <= (details.visualRegion === "bottom_band" ? 12 : details.visualRegion === "frame_grid" ? 9 : 3) && times.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0);
	const basis = details.contentBasis;
	const range = details.transcribedRange;
	const audio = details.audioStatus === "available" && details.audioTranscribed === true && Array.isArray(range) && range.length === 2 && range.every((time) => typeof time === "number" && Number.isFinite(time)) && range[0] >= 0 && range[1] <= 86400 && range[1] > range[0] && range[1] - range[0] <= 60;
	const comments = details.audienceCommentScope;
	const commentScope = details.commentStatus === "available" ? comments === "returned_subset" || comments === "empty_response" ? comments : void 0 : typeof details.commentStatus === "string" && comments === "unavailable" ? comments : void 0;
	const excerpts = [];
	const candidates = [
		{
			kind: "asr_text",
			value: details.audioExcerpt,
			available: audio
		},
		{
			kind: "subtitle_text",
			value: details.subtitleExcerpt,
			available: details.subtitleStatus === "available" && (basis === "subtitles" || basis === "subtitle_excerpt")
		},
		{
			kind: "visual_description",
			value: details.visualExcerpt,
			available: visual
		},
		{
			kind: "audience_comment",
			value: details.commentExcerpt,
			available: commentScope === "returned_subset"
		}
	];
	let remaining = 200;
	for (const item of candidates) {
		if (!item.available || typeof item.value !== "string" || !item.value.trim() || !remaining) continue;
		const text = Array.from(item.value.trim()).slice(0, Math.min(120, remaining)).join("");
		remaining -= Array.from(text).length;
		excerpts.push({
			kind: item.kind,
			text
		});
	}
	return {
		id,
		availability: source ? "available" : id ? "missing" : "unlinked",
		bvid: typeof details.bvid === "string" && /^BV[0-9A-Za-z]{10}$/u.test(details.bvid) ? details.bvid : void 0,
		contentBasis: basis === "metadata" || basis === "subtitles" || basis === "subtitle_excerpt" ? basis : basis === "audio_excerpt" && audio ? basis : basis === "sampled_frames" && visual ? basis : "unknown",
		visualScope: visual ? details.visualRegion === "crop" ? "crop" : details.visualRegion === "bottom_band" ? "bottom_band" : "sampled_frames" : typeof details.visualStatus === "string" && details.visualStatus !== "available" ? "not_observed" : "unknown",
		...visual && details.visualSource === "storyboard" ? { visualSource: "storyboard" } : {},
		sampledTimestamps: visual ? times.slice() : [],
		...visual && crop ? { visualCrop: crop } : {},
		audioScope: audio ? "transcribed_excerpt" : details.audioObserved === false ? "not_observed" : "unknown",
		...audio ? { transcribedRange: range.slice() } : {},
		...commentScope ? { audienceCommentScope: commentScope } : {},
		...excerpts.length ? { excerpts } : {}
	};
};
/** Derived reading support, never a new execution or sensory receipt. */
const readingSupport = (sources) => ({
	obtained: [...new Set(sources.filter((source) => source.availability === "available").flatMap((source) => ({
		metadata: ["video_metadata"],
		subtitles: ["subtitle_text"],
		subtitle_excerpt: ["subtitle_excerpt_text"],
		sampled_frames: ["sampled_frame_description"],
		audio_excerpt: ["asr_excerpt_text"],
		unknown: []
	})[source.contentBasis]))],
	notEstablished: [
		"direct_listening",
		"full_video_viewing",
		"tutorial_actions",
		"comment_absence",
		"all_viewers_interest"
	]
});
const readingDiary = (items, hours, now = Date.now()) => {
	const sources = new Map(items.filter((item) => isReading(item) && item.createdAt <= now).map((item) => [item.id, item]));
	return items.filter((item) => item.status === "active" && item.tags.includes("B站") && (item.origin === "event" && item.kind === "event" || item.origin === "diary" && item.kind === "diary") && item.createdAt >= now - hours * 36e5 && item.createdAt <= now).map((item) => {
		const type = item.origin === "diary" || item.tags.includes("阅读感想") ? "reflection" : "reading";
		const details = readingDetails(item);
		const bvid = typeof details?.bvid === "string" && /^BV[0-9A-Za-z]{10}$/u.test(details.bvid) ? details.bvid : void 0;
		const title = typeof details?.title === "string" ? details.title.slice(0, 120) : void 0;
		const text = type === "reflection" && typeof details?.thought === "string" ? details.thought : item.text;
		const readings = (Array.isArray(details?.readings) ? details.readings : []).slice(0, 3).filter((row) => typeof row?.bvid === "string" && /^BV[0-9A-Za-z]{10}$/u.test(row.bvid)).map((row) => ({
			bvid: row.bvid,
			title: typeof row.title === "string" ? row.title.slice(0, 80) : ""
		}));
		const sourceReadingIds = [...new Set(item.tags.filter((tag) => /^reading:[a-f0-9]{12}$/u.test(tag)).map((tag) => tag.slice(8)))].slice(0, 3);
		const evidence = type === "reading" ? [sourceEvidence(item.id, item)] : sourceReadingIds.length ? sourceReadingIds.map((id) => {
			const source = sources.get(id);
			return sourceEvidence(id, source?.subjectId === item.subjectId && (source?.createdAt ?? Infinity) <= item.createdAt ? source : void 0);
		}) : [sourceEvidence()];
		return {
			id: item.id,
			at: item.createdAt,
			type,
			bvid,
			title,
			sourceReadingId: sourceReadingIds.length === 1 ? sourceReadingIds[0] : void 0,
			sourceReadingIds,
			readings,
			sourceEvidence: evidence,
			text
		};
	}).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
};
const formatReadingDiary = (entries, hours, timezone) => {
	if (!entries.length) return `最近 ${hours} 小时没有已保存的阅读记录，不代表从未浏览。`;
	const clean = (text) => text.replace(/\s+/gu, " ").trim();
	const lines = entries.slice(0, 5).map((item) => {
		const time = new Date(item.at).toLocaleString("zh-CN", {
			timeZone: timezone,
			hour12: false
		});
		const label = item.type === "reflection" ? "想法" : "阅读";
		const detail = item.type === "reflection" ? clean(item.text).slice(0, 180) : item.title || clean(item.text).slice(0, 120);
		const scope = item.sourceEvidence?.map((source) => `${source.bvid || source.id || "未关联来源"}：${{
			metadata: "仅元数据",
			subtitles: "返回字幕",
			subtitle_excerpt: "字幕节选",
			sampled_frames: "采样静帧",
			audio_excerpt: "ASR转写片段",
			unknown: "范围未知"
		}[source.contentBasis]}${source.visualScope === "bottom_band" ? "，仅底部字幕带" : source.visualScope === "crop" ? "，仅指定局部" : ""}${source.visualSource === "storyboard" ? "，低清预览故事板" : ""}${source.transcribedRange ? `，转写范围${source.transcribedRange.join("–")}秒` : ""}`).join("；");
		return `${time} · ${label}\n${detail}${item.bvid ? `\n${item.bvid}` : ""}${item.readings?.length ? `\n${item.readings.map((row) => `${row.title} ${row.bvid}`).join("；")}` : ""}${scope ? `\n来源范围：${scope}` : ""}`;
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
		bvid: item.bvid,
		sourceEvidence: item.sourceEvidence
	}));
};

export { formatReadingDiary, readingContinuity, readingDiary, readingSupport, searchReadingDiary };