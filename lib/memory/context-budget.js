// src/memory/context-budget.ts
const groups = [
	"recentSources",
	"sharedDialogues",
	"sharedThreads",
	"recalled",
	"recentExperience",
	"profile"
];
const priority = (group, row) => {
	const match = row && typeof row === "object" && "match" in row ? row.match : void 0;
	if (group === "recentSources") return match === "keyword" ? 1 : 4;
	if (group === "sharedDialogues") return match === "text" ? 1 : 3;
	if (group === "sharedThreads") {
		if (row && typeof row === "object" && "state" in row && row.state === "cancelled") return 0;
		return match === "topic" ? 0 : 2;
	}
	if (group === "profile") return 0;
	return 1;
};
/** Omit whole low-priority rows, never detach a thought from its evidence. */
const renderMemoryContext = (instructions, data, maxChars = 16e3) => {
	if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("记忆上下文预算无效。");
	const payload = { ...data };
	for (const group of groups) payload[group] = data[group].slice();
	const contextOmissions = {};
	const render = () => {
		const omitted = Object.keys(contextOmissions).length > 0;
		return [
			...instructions,
			...omitted ? ["contextOmissions记录因本轮容量省略的条目数。省略不代表不存在；回答需要时使用可用的记忆或聊天来源工具继续核对，不据此否认历史。"] : [],
			JSON.stringify({
				...payload,
				...omitted ? { contextOmissions } : {}
			})
		].join("\n");
	};
	let result = render();
	while (result.length > maxChars) {
		let selected;
		for (const group of groups) for (const [index, row] of payload[group].entries()) {
			const rank = priority(group, row);
			if (!selected || rank > selected.rank || rank === selected.rank && index > selected.index) selected = {
				group,
				index,
				rank
			};
		}
		if (!selected) throw new Error("记忆规则本身超过上下文预算。");
		payload[selected.group].splice(selected.index, 1);
		contextOmissions[selected.group] = (contextOmissions[selected.group] || 0) + 1;
		result = render();
	}
	return result;
};

export { renderMemoryContext };