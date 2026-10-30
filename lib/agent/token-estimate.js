// src/agent/token-estimate.ts
/** Admission heuristic, not a tokenizer or a billed-usage measurement. */
const estimateModelRequestTokens = (messages, tools, outputTokens = 2048) => {
	let images = 0;
	const text = JSON.stringify({
		messages,
		tools: tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters
			}
		}))
	}, (key, value) => {
		if (key === "image_url" && value && typeof value === "object") {
			images++;
			return "[image]";
		}
		return value;
	});
	return Math.ceil(Buffer.byteLength(text) / 3) + images * 6e3 + outputTokens;
};

export { estimateModelRequestTokens };