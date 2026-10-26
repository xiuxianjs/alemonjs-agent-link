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

export { rankMemories, tokenizeMemory };