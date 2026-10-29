import { getMoodStore, moodOptions } from "./mood.js";
import { groupVoicePolicy } from "../social/group-settings.js";
import { createHash } from "node:crypto";

// src/companion/expression.ts
const expressionOptions = (config) => {
	const raw = config.modules?.settings?.expression || {};
	const options = {
		automatic: raw.automatic ?? true,
		voiceChance: raw.voiceChance ?? .15,
		stickerChance: raw.stickerChance ?? .35,
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
		pattern: /在不在|在吗|在么|在嘛|有人吗|在不在呀/u,
		intent: {
			names: ["在呢"],
			categories: ["日常"],
			tags: [
				"招呼",
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
		pattern: /晚安|睡了|困了|睡觉|好梦/u,
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
		pattern: /哈哈|笑死|好笑|开心|好耶|太好/u,
		intent: {
			names: ["好耶", "开心"],
			categories: ["开心"],
			tags: ["开心", "笑"],
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
			tags: ["生气", "不满"],
			context: ["不满", "生气"]
		}
	},
	{
		pattern: /委屈|难过|想哭|伤心|哭死/u,
		intent: {
			names: ["委屈", "难过"],
			categories: ["委屈"],
			tags: ["委屈", "难过"],
			context: ["委屈", "难过"]
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
const stickerIntent = (text) => text ? INTENTS.find((entry) => entry.pattern.test(text))?.intent : void 0;
const hasStickerIntent = (text) => Boolean(stickerIntent(text));
const selectIntentSticker = (items, userText) => {
	const intent = stickerIntent(userText);
	if (!intent) return void 0;
	return items.find((item) => Boolean(item.name && intent.names.includes(item.name)));
};
const INTENT_WORDS = /在不在|在吗|在么|在嘛|有人吗|晚安|睡了|困了|睡觉|好梦|哈哈|笑死|好笑|开心|好耶|太好|生气|好烦|讨厌|不满|气死|委屈|难过|想哭|伤心|哭死|害羞|不好意思|脸红|得意|厉害|牛啊|太强|崇拜|调皮|略略略|逗你|哼哼/gu;
/**
* A sticker can replace a greeting/acknowledgement, but not extra information.
* Keep the text when the user asked for more, or the answer contains facts/steps/links.
*/
const needsTextSupplement = (userText, answer) => {
	const residual = userText.replace(INTENT_WORDS, "").replace(/[\s，,。.!！?？~～呀啊嘛哦嗯]/gu, "");
	const substantive = /https?:\/\/|```|\n[-*]|\d{2,}|[%¥$]|因为|所以|但是|需要|建议|步骤|报错|错误|地址|链接|价格|时间|版本/u.test(answer);
	return residual.length > 0 || Array.from(answer).length > 24 || substantive;
};
const mood = (config, scope) => config.modules?.disabled?.includes("mood") ? 60 : getMoodStore(config).snapshot(scope, moodOptions(config), config.retentionDays).value;
const planExpression = (config, scope, inputId, media) => {
	const options = expressionOptions(config);
	const value = scope.platform && scope.channelId ? mood(config, scope) : 60;
	const automatic = options.automatic && !config.modules?.disabled?.includes("expression");
	const expressiveness = value >= 75 ? 1.25 : value < 45 ? .5 : 1;
	const voice = scope.platform && scope.channelId ? groupVoicePolicy(config, scope.channelId, scope.platform) : {
		allowed: true,
		auto: true
	};
	return {
		voice: Boolean(automatic && voice.allowed && voice.auto && !config.modules?.disabled?.includes("voice") && (media?.tts?.voice || media?.speech) && sample(inputId, "voice") < Math.min(1, options.voiceChance * expressiveness)),
		sticker: Boolean(automatic && media?.stickerRoot && sample(inputId, "sticker") < Math.min(1, options.stickerChance * expressiveness)),
		delayMs: automatic ? Math.min(3e3, Math.round((options.delayMs[0] + sample(inputId, "delay") * (options.delayMs[1] - options.delayMs[0])) * (value < 45 ? 1.2 : 1))) : 0
	};
};
const automaticVoiceText = (text, limit) => Boolean(text.trim()) && Array.from(text).length <= Math.min(240, limit) && !/```|https?:\/\/|\|.*\||\[沉默\]/u.test(text);
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
	const ranked = items.map((item) => {
		let score = item.tags.reduce((sum, tag) => sum + (text.includes(tag) ? 3 : related.includes(tag) ? 1 : 0), 0);
		if (intent) {
			if (item.name && intent.names.includes(item.name)) score += 40;
			else if (item.name && intent.names.some((name) => item.name?.includes(name))) score += 10;
			if (intent.categories.includes(item.category || "")) score += 8;
			if (intent.tags.some((tag) => item.tags.includes(tag))) score += 6;
			if (item.context && intent.context.some((keyword) => item.context?.includes(keyword))) score += 4;
		}
		return {
			item,
			score,
			tie: sample(inputId, item.id)
		};
	}).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.tie - b.tie);
	if (ranked[0]) return ranked[0].item;
	if (!fallback || !items.length) return void 0;
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

export { automaticVoiceText, expressionOptions, hasStickerIntent, moodGroupPolicy, needsTextSupplement, planExpression, selectExpressionSticker, selectIntentSticker, stickerIntent };