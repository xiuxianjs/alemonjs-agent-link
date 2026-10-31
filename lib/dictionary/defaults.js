import { dictionaryHistory } from "./history.js";

// src/dictionary/defaults.ts
/** 2026-10-30 核实；今年使用的词，不等同于今年首创或年度排名。来源见 docs/dictionary-defaults.md。 */
const initialVersion = "2026-10-30-v1";
const initialDefaults = [
	{
		term: "爱你老己",
		aliases: [],
		definition: "把自己亲切地叫作“老己”，表达好好照顾自己、给自己一点奖励。常用于自我安慰。"
	},
	{
		term: "老来得己",
		aliases: [],
		definition: "调侃终于开始关注自己的需要，找回自己，而非字面上的晚年生育。"
	},
	{
		term: "前额叶友好",
		aliases: [],
		definition: "网络上形容省心、易理解、不增加决策负担；不是医学判断。"
	},
	{
		term: "大脑降噪",
		aliases: [],
		definition: "比喻减少杂乱信息和思虑，让自己缓一缓；不是治疗效果描述。"
	},
	{
		term: "人生奥德赛时期",
		aliases: ["人生奥德赛", "奥德赛时期"],
		definition: "形容人生方向尚未确定、边探索边试错的一段时期，不是固定年龄诊断。"
	},
	{
		term: "背手负鼠",
		aliases: [],
		definition: "以背手、佝偻的负鼠形象表达疲惫、无奈却仍要继续的心情。"
	},
	{
		term: "哭哭马",
		aliases: [],
		definition: "委屈表情的马形象热梗，常被用来代言自己的委屈或疲惫。"
	},
	{
		term: "低电量人生",
		aliases: [],
		definition: "把精力比作电量，自嘲容易累、需要休息的生活状态。"
	},
	{
		term: "手搓一切",
		aliases: [],
		definition: "夸张地说自己动手做出各种东西；AI语境下也可指借助AI制作内容或应用，不一定全靠手工。"
	},
	{
		term: "我见识到自己的厉害了",
		aliases: [],
		definition: "对自己的能力或进步表示肯定；也可能是反讽，需结合上下文。"
	},
	{
		term: "低山臭水遇知音",
		aliases: ["低山臭水"],
		definition: "自嘲彼此的奇怪笑点、趣味或脑回路很合拍；不是在认真评价山水。"
	},
	{
		term: "不知道，我的身材很曼妙",
		aliases: ["不知道我的身材很曼妙", "我的身材很曼妙"],
		definition: "用不相干的自夸故意岔开问题，属于搞怪式答非所问；认真求助时不应拿来敷衍。"
	},
	{
		term: "随橙想",
		aliases: [],
		definition: "对“谁曾想”等表达的空耳式玩梗写法，用来引出意料之外的发展，不当作规范用字。"
	},
	{
		term: "我去，不早说",
		aliases: ["我去不早说"],
		definition: "吐槽消息来晚了，或反讽对方刚说了人人都知道的事；不一定真在责怪。"
	},
	{
		term: "我将辞职在家研究",
		aliases: ["辞职在家全职研究"],
		definition: "夸张地表达某件事太有意思、值得反复琢磨，通常不是实际辞职计划。"
	},
	{
		term: "活人感",
		aliases: [],
		definition: "形容表达自然、有个人情绪和生活细节，不机械、不像套模板；不是生物身份的证据。"
	},
	{
		term: "情绪价值",
		aliases: [],
		definition: "互动或体验带来的被理解、被支持、开心等感受，不表示必须无条件赞同。"
	},
	{
		term: "赛博对账",
		aliases: [],
		definition: "网友在网上相互核对经历、生活细节或共同记忆，以发现共鸣或差异。具体场景也可能真在谈账单。"
	}
];
const dictionaryDefaultsVersion = "2026-10-31-history-v1";
const dictionarySeedBatches = [{
	version: initialVersion,
	entries: initialDefaults
}, {
	version: dictionaryDefaultsVersion,
	entries: dictionaryHistory.map(({ term, aliases, definition, year }) => ({
		term,
		aliases,
		definition: `【${year}流行记录，非首创年份】${definition}`
	}))
}];
const dictionaryDefaults = dictionarySeedBatches.flatMap((batch) => batch.entries);

export { dictionaryDefaults, dictionaryDefaultsVersion, dictionarySeedBatches };