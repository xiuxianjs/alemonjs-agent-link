import { tokenizeMemory } from "../memory/retrieval.js";
import { normalizeQaText } from "./detection.js";

// src/qa/retrieval.ts
/**
* 问答库排序。与长期记忆不同，问答匹配更看重“问题本身是否问的是同一件事”：
* 问题是短句，若只看词频，任何带“为什么”的句子都会互相命中。
* 因此先要求问题覆盖率、关键词或精确包含，再用来源可信度、命中次数与时间排序。
*/
const rankQa = (items, query, options = {}) => {
	const normalizedQuery = normalizeQaText(query);
	const queryTokens = new Set(tokenizeMemory(query));
	if (!normalizedQuery || !queryTokens.size) return [];
	const now = options.now ?? Date.now();
	const threshold = options.threshold ?? 3.5;
	const queryLatin = new Set(normalizedQuery.match(/[a-z0-9]+/gu) || []);
	const ranked = [];
	for (const item of items) {
		const normalizedQuestion = normalizeQaText(item.question);
		const documentTokens = new Set(tokenizeMemory(`${item.question} ${item.keywords.join(" ")} ${item.tags.join(" ")}`));
		let overlap = 0;
		for (const token of queryTokens) if (documentTokens.has(token)) overlap++;
		const coverage = overlap / queryTokens.size;
		const exact = normalizedQuery.length >= 4 && normalizedQuestion.length >= 4 && (normalizedQuery.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedQuery));
		const keyword = item.keywords.some((value) => {
			const normalized = normalizeQaText(value);
			if (normalized.length < 2) return false;
			return /^[a-z0-9]+$/u.test(normalized) ? queryLatin.has(normalized) : normalizedQuery.includes(normalized) || normalized.includes(normalizedQuery);
		});
		if (!exact && !keyword && (overlap < 3 || coverage < .7)) continue;
		const trust = item.origin === "explicit" ? 1.2 : item.origin === "builtin" ? 1 : .6;
		const trustScore = Math.max(0, Math.min(1, item.confidence)) * trust;
		const popularity = Math.min(1, item.hits / 20) * .4;
		const recency = .5 * Math.pow(.5, Math.max(0, now - item.updatedAt) / 15552e6);
		const score = coverage * 6 + (exact ? 4 : 0) + (keyword ? 2 : 0) + trustScore + popularity + recency;
		if (score < threshold) continue;
		ranked.push({
			...item,
			score
		});
	}
	return ranked.sort((a, b) => b.score - a.score || b.confidence - a.confidence || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
};

export { rankQa };