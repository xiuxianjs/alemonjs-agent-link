// src/memory/query-context.ts
var MemoryQueryContext = class {
	entries = /* @__PURE__ */ new Map();
	resolve(scope, text, update = true, now = Date.now()) {
		const key = JSON.stringify([
			scope.platform,
			scope.channelId,
			scope.userId,
			scope.generation
		]);
		const previous = this.entries.get(key);
		const short = text.trim().length < 8;
		const query = short && previous && now - previous.at < 3e5 ? `${previous.text} ${text}` : text;
		if (update && !short) {
			this.entries.delete(key);
			this.entries.set(key, {
				text: text.slice(0, 500),
				at: now
			});
		}
		for (const [id, entry] of this.entries) if (now - entry.at >= 3e5) this.entries.delete(id);
		while (this.entries.size > 1e3) this.entries.delete(this.entries.keys().next().value);
		return query;
	}
};

export { MemoryQueryContext };