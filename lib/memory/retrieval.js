import { cosineSimilarity } from "./embedding.js";

// src/memory/retrieval.ts
const tokenizeMemory = (text) => {
	const tokens = [];
	for (const match of String(text).toLowerCase().matchAll(/[a-z0-9_]{2,}|[\u3400-\u9fff]+/gu)) {
		const word = match[0];
		if (/^[a-z0-9_]+$/u.test(word) || word.length === 1) tokens.push(word);
		else for (let index = 0; index < word.length - 1; index++) tokens.push(word.slice(index, index + 2));
	}
	return tokens;
};
const rankMemories = (items, query, subjectId, now = Date.now()) => {
	const terms = new Set(tokenizeMemory(query));
	const frequencies = /* @__PURE__ */ new Map();
	const docs = items.map((item) => {
		const tokens = tokenizeMemory(`${item.text} ${item.tags.join(" ")}`);
		const counts = /* @__PURE__ */ new Map();
		for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
		for (const token of counts.keys()) frequencies.set(token, (frequencies.get(token) || 0) + 1);
		return {
			item,
			counts,
			length: tokens.length || 1
		};
	});
	const average = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
	const hits = [];
	for (const doc of docs) {
		let lexical = 0;
		for (const term of terms) {
			const count = doc.counts.get(term) || 0;
			if (!count) continue;
			const idf = Math.log(1 + (docs.length - (frequencies.get(term) || 0) + .5) / ((frequencies.get(term) || 0) + .5));
			lexical += idf * count * 2.2 / (count + 1.2 * (.25 + .75 * doc.length / average));
		}
		if (terms.size && lexical === 0) continue;
		const days = Math.max(0, now - Math.max(doc.item.updatedAt, doc.item.lastRecalledAt)) / 864e5;
		const halfLife = 14 + doc.item.importance * 60 + Math.min(60, doc.item.recallDays * 3);
		const retention = .25 + .75 * Math.pow(.5, days / halfLife);
		const person = subjectId && doc.item.subjectId === subjectId ? 1.6 : 1;
		const score = (lexical || .15) * person * (.6 + doc.item.importance) * doc.item.confidence * retention;
		hits.push({
			...doc.item,
			score
		});
	}
	return hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
};
const retentionFactor = (item, now) => {
	const days = Math.max(0, now - Math.max(item.updatedAt, item.lastRecalledAt)) / 864e5;
	const halfLife = 14 + item.importance * 60 + Math.min(60, item.recallDays * 3);
	return .25 + .75 * Math.pow(.5, days / halfLife);
};
/**
* 在 BM25 结果上叠加可选 embedding：词面命中保留原分数，语义相近但词面不同的
* 条目以较低基础分进入候选。没有向量时保持原排序，不改变已有召回语义。
*/
const rankMemoriesHybrid = (items, lexical, queryVector, vectors, subjectId, weight, now = Date.now()) => {
	const lexicalScores = new Map(lexical.map((item) => [item.id, item.score]));
	const threshold = .45;
	const scored = [];
	for (const item of items) {
		const lexicalScore = lexicalScores.get(item.id) || 0;
		const vector = vectors.get(item.id);
		const cosine = vector?.length === queryVector.length ? Math.max(0, Math.min(1, cosineSimilarity(queryVector, vector))) : 0;
		if (!lexicalScore && cosine < threshold) continue;
		const meta = (subjectId && item.subjectId === subjectId ? 1.6 : 1) * (.6 + item.importance) * item.confidence * retentionFactor(item, now);
		const score = lexicalScore ? lexicalScore * (1 + weight * cosine) : weight * cosine * .35 * meta;
		scored.push({
			...item,
			score
		});
	}
	return scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
};

export { rankMemories, rankMemoriesHybrid, tokenizeMemory };