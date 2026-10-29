// src/bili/preferences.ts
const browsePreferences = (settings) => {
	const parse = (value) => {
		if (value === void 0) return [];
		if (!Array.isArray(value) || value.length > 10 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 40 || /[\r\n]/u.test(item))) throw new Error("每日阅读主题与避雷词应为最多 10 个、每个 1–40 字的单行文字。");
		return [...new Set(value.map((item) => item.trim()))];
	};
	return {
		topics: parse(settings.dailyBrowseTopics),
		exclude: parse(settings.dailyBrowseExclude)
	};
};
const excludedBrowseTopic = (item, excluded) => {
	const text = `${item.title}\n${item.description}`.normalize("NFKC").toLocaleLowerCase("en-US");
	return excluded.some((word) => text.includes(word.normalize("NFKC").toLocaleLowerCase("en-US")));
};
/** Preference matches describe metadata relevance, not video quality or verified content. */
const rankBrowseCandidates = (items, topics) => {
	const normalized = (text) => text.normalize("NFKC").toLocaleLowerCase("en-US");
	const unique = [...new Map(topics.map((topic) => [normalized(topic), topic])).entries()];
	return items.map((item, index) => {
		const title = normalized(item.title);
		const description = normalized(item.description);
		const matchedTopics = [];
		let score = 0;
		for (const [keyword, label] of unique) if (title.includes(keyword)) {
			score += 2;
			matchedTopics.push(label);
		} else if (description.includes(keyword)) {
			score++;
			matchedTopics.push(label);
		}
		return {
			item,
			index,
			score,
			matchedTopics
		};
	}).sort((a, b) => b.score - a.score || a.index - b.index).map(({ item, matchedTopics }) => ({
		...item,
		matchedTopics
	}));
};
const parseBrowseFeedback = (text) => {
	const match = text.trim().match(/^(以后多看|以后别看|以后不要看|恢复推荐)[：:、\s]*(.{1,40}?)[。！!]*$/u);
	if (!match || /[“”"「」<>\r\n？?]/u.test(match[2])) return void 0;
	const topic = match[2].trim();
	if (!topic || /^(?:这个|那个|这类|那类|这个视频|那个视频|它|什么|什么视频)$/u.test(topic) || /(?:吗|么|如何|怎么)$/u.test(topic)) return void 0;
	return {
		topic,
		preference: match[1] === "以后多看" ? "like" : match[1] === "恢复推荐" ? "clear" : "avoid"
	};
};
const mergeBrowseFeedback = (configured, feedback) => {
	const avoid = feedback.filter((item) => item.preference === "avoid").map((item) => item.topic);
	const normalized = (text) => text.normalize("NFKC").toLowerCase();
	const excluded = new Set([...configured.exclude, ...avoid].map(normalized));
	return {
		topics: [.../* @__PURE__ */ new Set([...configured.topics, ...feedback.filter((item) => item.preference === "like").map((item) => item.topic)])].filter((topic) => !excluded.has(normalized(topic))),
		exclude: [.../* @__PURE__ */ new Set([...configured.exclude, ...avoid])]
	};
};
/** Rotate through explicit topics by local calendar day rather than choosing randomly each turn. */
const dailyReadingTopic = (topics, day, offset) => {
	if (!topics.length) return "";
	return topics[((Math.floor(Date.parse(`${day}T12:00:00Z`) / 864e5) + offset) % topics.length + topics.length) % topics.length] || "";
};

export { browsePreferences, dailyReadingTopic, excludedBrowseTopic, mergeBrowseFeedback, parseBrowseFeedback, rankBrowseCandidates };