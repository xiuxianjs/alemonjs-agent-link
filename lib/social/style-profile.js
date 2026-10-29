// src/social/style-profile.ts
const PARTICLES = [
	"笑死",
	"绷不住",
	"离谱",
	"绝了",
	"好家伙",
	"啊",
	"呀",
	"吧",
	"呢",
	"吗",
	"嘛",
	"哈",
	"草",
	"6",
	"233",
	"hhh",
	"emmm",
	"喵",
	"捏",
	"咧",
	"呗",
	"咯",
	"？",
	"??"
];
const clean = (text) => text.replace(/\s+/gu, " ").trim();
/**
* 从当前群的近期消息里提取少量“说话方式”线索，供模型自然跟随。
* 只做本地统计，不调用模型，不保存原文；样本不足时返回空串。
*/
const styleHint = (messages, scope = "group") => {
	const texts = messages.filter((item) => item.speaker !== "__bot__").map((item) => clean(item.text)).filter((text) => (text.length >= 2 || text.length === 1 && PARTICLES.includes(text)) && text.length <= 200 && !text.startsWith("/") && !/^https?:\/\//u.test(text) && !/^\[附件:/u.test(text)).slice(-30);
	if (texts.length < (scope === "private" ? 5 : 8)) return "";
	const lengths = texts.map((text) => Array.from(text).length).sort((a, b) => a - b);
	const median = lengths[Math.floor(lengths.length / 2)];
	const noPunctuation = texts.filter((text) => !/[。！？!?~…]$/u.test(text)).length / texts.length;
	const counts = /* @__PURE__ */ new Map();
	for (const text of texts) for (const particle of PARTICLES) if (text.includes(particle)) counts.set(particle, (counts.get(particle) || 0) + 1);
	const top = [...counts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([particle]) => particle);
	const parts = [`最近 ${texts.length} 条${scope === "private" ? "私聊" : "群聊"}中位 ${median} 字`];
	if (median <= 12) parts.push("偏短句");
	if (noPunctuation >= .6) parts.push("多数不带句末标点");
	if (top.length) parts.push(`常见语气：${top.join("、")}`);
	return `${parts.join("；")}。`.slice(0, 180);
};
const groupStyleHint = (messages) => styleHint(messages, "group");

export { groupStyleHint, styleHint };