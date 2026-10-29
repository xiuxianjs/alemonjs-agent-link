// src/social/perception-context.ts
const selectPerceptionContext = (recent, lastBotReply, currentTexts, now, options = {
	maxMessages: 40,
	windowSeconds: 1800,
	maxChars: 6e3
}) => {
	const fresh = (item) => now - item.at < options.windowSeconds * 1e3 && item.at <= now;
	const selected = [];
	let remaining = options.maxChars;
	const add = (item) => {
		if (!fresh(item) || remaining <= 0 || selected.length >= options.maxMessages || selected.includes(item)) return;
		const text = item.text.slice(0, Math.min(400, remaining));
		remaining -= text.length;
		selected.push({
			...item,
			text
		});
	};
	if (lastBotReply) add(lastBotReply);
	for (const item of [...recent].reverse()) {
		if (currentTexts.has(item.text) || selected.some((line) => line.at === item.at && line.speaker === item.speaker)) continue;
		add(item);
	}
	return selected.sort((a, b) => a.at - b.at);
};

export { selectPerceptionContext };