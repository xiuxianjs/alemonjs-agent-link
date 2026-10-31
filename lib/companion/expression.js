import { getPersonaStore } from "./personas.js";
import { isQuietHour } from "../social/group-policy.js";
import { groupPolicy, groupVoicePolicy } from "../social/group-settings.js";
import { getAffinityStore } from "./affinity.js";
import { getMoodStore, moodOptions } from "./mood.js";
import { voiceMotivation } from "./voice-policy.js";
import { createHash } from "node:crypto";

// src/companion/expression.ts
const expressionOptions = (config) => {
	const raw = config.modules?.settings?.expression || {};
	const options = {
		automatic: raw.automatic ?? true,
		voiceChance: raw.voiceChance ?? .15,
		stickerChance: raw.stickerChance ?? .6,
		stickerFallback: raw.stickerFallback ?? false,
		stickerIntentAlways: raw.stickerIntentAlways ?? true,
		stickerMode: raw.stickerMode ?? "either",
		modelVoice: raw.modelVoice ?? false,
		socialPolish: raw.socialPolish ?? true,
		delayMs: raw.delayMs ?? [0, 0]
	};
	if (typeof options.automatic !== "boolean" || typeof options.stickerFallback !== "boolean" || typeof options.stickerIntentAlways !== "boolean" || typeof options.modelVoice !== "boolean" || typeof options.socialPolish !== "boolean" || !["either", "both"].includes(String(options.stickerMode)) || !Number.isFinite(options.voiceChance) || Number(options.voiceChance) < 0 || Number(options.voiceChance) > 1 || !Number.isFinite(options.stickerChance) || Number(options.stickerChance) < 0 || Number(options.stickerChance) > 1 || !Array.isArray(options.delayMs) || options.delayMs.length !== 2 || options.delayMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 3e3) || options.delayMs[0] > options.delayMs[1]) throw new Error("expression 设置无效。");
	return {
		automatic: options.automatic,
		voiceChance: Number(options.voiceChance),
		stickerChance: Number(options.stickerChance),
		stickerFallback: options.stickerFallback,
		stickerIntentAlways: options.stickerIntentAlways,
		stickerMode: options.stickerMode,
		modelVoice: options.modelVoice,
		socialPolish: options.socialPolish,
		delayMs: options.delayMs
	};
};
const sample = (id, purpose) => createHash("sha256").update(JSON.stringify([id, purpose])).digest().readUInt32BE(0) / 4294967296;
const INTENTS = [
	{
		pattern: /谢谢|感谢/u,
		social: true,
		intent: {
			names: ["谢谢", "感谢"],
			categories: ["感谢"],
			tags: [
				"谢谢",
				"感谢",
				"感恩"
			],
			context: ["感谢"]
		}
	},
	{
		pattern: /^(?:肥鱼[，,\s]*)?(?:好的|好哒|收到|明白了|知道了)[！!。\s]*$/u,
		social: true,
		intent: {
			names: [
				"收到",
				"好的",
				"OK"
			],
			categories: ["收到"],
			tags: [
				"收到",
				"好的",
				"点头",
				"OK"
			],
			context: ["确认"]
		}
	},
	{
		pattern: /无语|无言|扶额/u,
		intent: {
			names: ["无语", "扶额"],
			categories: ["无语"],
			tags: [
				"无语",
				"无言",
				"扶额"
			],
			context: ["无语"]
		}
	},
	{
		pattern: /震惊|惊讶|惊呆/u,
		intent: {
			names: ["震惊", "惊讶"],
			categories: ["惊讶"],
			tags: [
				"震惊",
				"惊讶",
				"惊呆"
			],
			context: ["惊讶"]
		}
	},
	{
		pattern: /喜欢你|爱你|比心/u,
		intent: {
			names: ["比心", "爱你"],
			categories: ["喜爱"],
			tags: [
				"比心",
				"爱你",
				"喜欢",
				"爱心"
			],
			context: ["喜爱"]
		}
	},
	{
		social: true,
		pattern: /在不在|在吗|在么|在嘛|有人吗|在不在呀|你好|嗨/u,
		intent: {
			names: [
				"在呢",
				"你好",
				"嗨"
			],
			categories: ["日常"],
			tags: [
				"招呼",
				"你好",
				"嗨",
				"回应",
				"日常"
			],
			context: [
				"招呼",
				"回应",
				"在呢"
			]
		}
	},
	{
		pattern: /早安|早上好/u,
		social: true,
		intent: {
			names: ["早安", "早上好"],
			categories: ["问候"],
			tags: [
				"早安",
				"早上好",
				"问候"
			],
			context: ["早晨", "问候"]
		}
	},
	{
		pattern: /晚安|睡了|困了|睡觉|好梦/u,
		social: true,
		intent: {
			names: ["晚安", "睡了"],
			categories: ["晚安"],
			tags: ["晚安", "困"],
			context: [
				"睡前",
				"困倦",
				"晚安"
			]
		}
	},
	{
		pattern: /哈哈|嘿嘿|嘻嘻|笑喷|笑麻|乐死|芜湖|笑死|好笑|开心|好耶|太好/u,
		intent: {
			names: [
				"好耶",
				"开心",
				"笑死",
				"哈哈"
			],
			categories: ["开心"],
			tags: [
				"开心",
				"笑",
				"哈哈",
				"哈哈哈",
				"大笑",
				"爆笑",
				"笑死",
				"搞笑",
				"高兴",
				"快乐",
				"嘿嘿",
				"嘻嘻",
				"笑喷",
				"笑麻",
				"芜湖"
			],
			context: [
				"庆祝",
				"好消息",
				"开心"
			]
		}
	},
	{
		pattern: /生气|好烦|讨厌|不满|气死/u,
		intent: {
			names: ["生气", "不满"],
			categories: ["不满"],
			tags: [
				"生气",
				"不满",
				"愤怒",
				"气愤",
				"炸毛"
			],
			context: ["不满", "生气"]
		}
	},
	{
		pattern: /委屈|难过|想哭|伤心|哭死|抱抱/u,
		intent: {
			names: ["抱抱", "安慰"],
			categories: ["安慰"],
			tags: [
				"抱抱",
				"安慰",
				"拥抱",
				"摸摸",
				"拍拍",
				"陪伴",
				"心疼"
			],
			context: ["陪伴", "安慰"]
		}
	},
	{
		pattern: /害羞|不好意思|脸红/u,
		intent: {
			names: ["害羞"],
			categories: ["害羞"],
			tags: ["害羞"],
			context: ["害羞"]
		}
	},
	{
		pattern: /得意|厉害|牛啊|太强|崇拜/u,
		intent: {
			names: ["得意", "厉害"],
			categories: ["得意"],
			tags: ["得意", "厉害"],
			context: ["自夸", "得意"]
		}
	},
	{
		pattern: /调皮|略略略|逗你|哼哼/u,
		intent: {
			names: ["调皮", "哼哼"],
			categories: ["调皮"],
			tags: ["调皮", "搞怪"],
			context: [
				"互损",
				"调皮",
				"得意"
			]
		}
	}
];
const stickerIntent = (text) => {
	if (!text || /[“”「」"<>]|他说|她说|有人说|不要|别再|不许|并不|不是|不(?:开心|难过|生气|困|委屈)|怎么|如何|为什么|什么叫/u.test(text)) return void 0;
	const matched = INTENTS.filter((entry) => entry.pattern.test(text));
	const reactions = matched.filter((entry) => !entry.social);
	const candidates = reactions.length ? reactions : matched;
	return candidates.length === 1 ? candidates[0].intent : void 0;
};
const hasStickerIntent = (text) => Boolean(stickerIntent(text));
const matchesStickerIntent = (item, intent) => Boolean(item.name && intent.names.includes(item.name)) || item.tags.some((tag) => ![
	"日常",
	"回应",
	"问候"
].includes(tag) && intent.tags.includes(tag));
const selectIntentSticker = (items, userText) => {
	const intent = stickerIntent(userText);
	if (!intent) return void 0;
	const exact = items.find((item) => Boolean(item.name && intent.names.includes(item.name)));
	if (exact) return exact;
	return items.find((item) => matchesStickerIntent(item, intent));
};
const INTENT_WORDS = /在不在|在吗|在么|在嘛|有人吗|早安|早上好|晚安|睡了|困了|睡觉|好梦|哈哈|嘿嘿|嘻嘻|笑喷|笑麻|乐死|芜湖|笑死|好笑|开心|好耶|太好|生气|好烦|讨厌|不满|气死|委屈|难过|想哭|伤心|哭死|害羞|不好意思|脸红|得意|厉害|牛啊|太强|崇拜|调皮|略略略|逗你|哼哼/gu;
/**
* A sticker can replace a greeting/acknowledgement, but not extra information.
* Keep the text when the user asked for more, or the answer contains facts/steps/links.
*/
const needsTextSupplement = (userText, answer) => {
	const residual = userText.replace(/^(?:大肥鱼|大肥鱼|肥鱼|小鲸鱼)[，,：:\s]*/u, "").replace(INTENT_WORDS, "").replace(/[\s，,。.!！?？~～呀啊嘛哦嗯哈]/gu, "");
	const simpleEmotion = hasStickerIntent(userText) && /^(?:我|今天|有点|真的|好|很|太|了|死|啦|呢)*$/u.test(residual);
	const substantive = /https?:\/\/|```|\n[-*]|\d|[%¥$]|因为|所以|但是|需要|建议|步骤|报错|错误|地址|链接|价格|时间|版本/u.test(answer);
	const extraReply = answer.replace(/在(?:的|呢|听)?|早(?:安|上好)?|晚安|好梦|哈哈+|嘿嘿|嘻嘻|笑喷|笑麻|乐死|芜湖|笑死|好耶|开心|抱(?:抱|一下)|摸摸|拍拍|哼哼?|恭喜|给你|给我|你|我/gu, "").replace(/[\s，,。.!！?？~～呀啊嘛哦嗯哈啦呢]/gu, "");
	return !simpleEmotion || Array.from(answer).length > 24 || substantive || extraReply.length > 0;
};
const mood = (config, scope) => config.modules?.disabled?.includes("mood") ? 60 : getMoodStore(config).snapshot(scope, moodOptions(config), config.retentionDays).value;
const planExpression = (config, scope, inputId, media, situation) => {
	const options = expressionOptions(config);
	const value = scope.platform && scope.channelId ? mood(config, scope) : 60;
	const automatic = options.automatic && !config.modules?.disabled?.includes("expression");
	const expressiveness = value >= 75 ? 1.25 : value < 45 ? .5 : 1;
	const voice = scope.platform && scope.channelId ? groupVoicePolicy(config, scope.channelId, scope.platform) : {
		allowed: true,
		auto: true
	};
	let affinity = 50;
	if (situation?.userId && !config.modules?.disabled?.includes("affinity")) {
		const personaId = String(getPersonaStore(config).selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona);
		if (personaId === "dafeiyu") affinity = getAffinityStore(config).snapshot({
			...scope,
			userId: situation.userId,
			personaId
		}).score;
	}
	const policy = groupPolicy(config, scope.channelId, scope.platform);
	const hour = Number(new Intl.DateTimeFormat("en-GB", {
		hour: "2-digit",
		hourCycle: "h23",
		timeZone: policy.timezone
	}).format(situation?.now ?? Date.now()));
	const motivation = voiceMotivation(situation && {
		...situation,
		affinity,
		quiet: isQuietHour(hour, policy.quietHours)
	}, value);
	return {
		voice: Boolean(automatic && voice.allowed && voice.auto && !config.modules?.disabled?.includes("voice") && (media?.tts?.voice || media?.speech) && motivation > 0 && sample(inputId, "voice") < Math.min(1, options.voiceChance * motivation)),
		sticker: Boolean(automatic && media?.stickerRoot && sample(inputId, "sticker") < Math.min(1, options.stickerChance * expressiveness)),
		delayMs: automatic ? Math.min(3e3, Math.round((options.delayMs[0] + sample(inputId, "delay") * (options.delayMs[1] - options.delayMs[0])) * (value < 45 ? 1.2 : 1))) : 0
	};
};
const automaticVoiceText = (text, limit) => Boolean(text.trim()) && Array.from(text).length <= Math.min(100, limit) && !/```|https?:\/\/|\|.*\||\[沉默\]|\n[-*]|配置|命令|步骤|首先|其次/u.test(text);
const selectExpressionSticker = (items, text, moodValue, inputId, fallback = false, userText = "") => {
	const related = moodValue >= 75 ? [
		"开心",
		"愉快",
		"高兴",
		"快乐",
		"笑"
	] : moodValue < 45 ? [
		"低落",
		"难过",
		"疲惫",
		"叹气"
	] : [
		"平和",
		"日常",
		"点头"
	];
	const intent = stickerIntent(userText);
	if (!intent && userText && INTENTS.some((entry) => entry.pattern.test(userText))) return void 0;
	const ranked = items.map((item) => {
		if (intent && !matchesStickerIntent(item, intent)) return {
			item,
			score: 0,
			tie: 0
		};
		let score = item.tags.reduce((sum, tag) => sum + (text.includes(tag) ? 3 : 0), 0);
		if (intent) {
			if (item.name && intent.names.includes(item.name)) score += 40;
			else if (item.name && intent.names.some((name) => item.name?.includes(name))) score += 10;
			if (intent.categories.includes(item.category || "")) score += 8;
			if (intent.tags.some((tag) => item.tags.includes(tag))) score += 6;
			if (item.context && intent.context.some((keyword) => item.context?.includes(keyword))) score += 4;
		}
		if (score > 0) score += item.tags.filter((tag) => related.includes(tag)).length;
		return {
			item,
			score,
			tie: sample(inputId, item.id)
		};
	}).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.tie - b.tie);
	if (ranked[0]) return ranked[0].item;
	if (intent || !fallback || !items.length) return void 0;
	return [...items].sort((a, b) => sample(inputId, a.id) - sample(inputId, b.id))[0];
};
const moodGroupPolicy = (config, scope, policy) => {
	if (!scope.platform || config.modules?.disabled?.includes("mood")) return policy;
	const value = mood(config, scope);
	return value < 45 ? {
		...policy,
		cooldownSeconds: Math.min(86400, Math.ceil(policy.cooldownSeconds * (value < 25 ? 2 : 1.5)))
	} : policy;
};
const recentStickers = /* @__PURE__ */ new Map();
const recordExpressionSticker = (scope, id, now = Date.now()) => {
	const recent = (recentStickers.get(scope) || []).filter((item) => now - item.at < 18e5 && item.id !== id);
	recentStickers.delete(scope);
	recentStickers.set(scope, [...recent, {
		id,
		at: now
	}].slice(-3));
	while (recentStickers.size > 1e3) recentStickers.delete(recentStickers.keys().next().value);
};
const freshExpressionStickers = (items, scope, now = Date.now()) => {
	const recent = (recentStickers.get(scope) || []).filter((item) => now - item.at < 18e5);
	if (!recent.length) recentStickers.delete(scope);
	const excluded = new Set(recent.map((item) => item.id));
	return items.filter((item) => !excluded.has(item.id));
};
/** Prefer variety, but allow a relevant exhausted candidate again after one minute. */
const selectFreshExpressionSticker = (items, scope, select, now = Date.now()) => {
	const fresh = select(freshExpressionStickers(items, scope, now));
	if (fresh) return fresh;
	const blocked = new Set((recentStickers.get(scope) || []).filter((item) => now - item.at < 6e4).map((item) => item.id));
	return select(items.filter((item) => !blocked.has(item.id)));
};

export { automaticVoiceText, expressionOptions, freshExpressionStickers, hasStickerIntent, moodGroupPolicy, needsTextSupplement, planExpression, recordExpressionSticker, selectExpressionSticker, selectFreshExpressionSticker, selectIntentSticker, stickerIntent };