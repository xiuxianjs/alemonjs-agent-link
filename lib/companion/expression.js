import { getMoodStore, moodOptions } from "./mood.js";
import { createHash } from "node:crypto";

// src/companion/expression.ts
const expressionOptions = (config) => {
	const raw = config.modules?.settings?.expression || {};
	const options = {
		automatic: raw.automatic ?? false,
		voiceChance: raw.voiceChance ?? .1,
		stickerChance: raw.stickerChance ?? .15,
		delayMs: raw.delayMs ?? [0, 0]
	};
	if (typeof options.automatic !== "boolean" || !Number.isFinite(options.voiceChance) || Number(options.voiceChance) < 0 || Number(options.voiceChance) > 1 || !Number.isFinite(options.stickerChance) || Number(options.stickerChance) < 0 || Number(options.stickerChance) > 1 || !Array.isArray(options.delayMs) || options.delayMs.length !== 2 || options.delayMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 3e3) || options.delayMs[0] > options.delayMs[1]) throw new Error("expression 设置无效。");
	return {
		automatic: options.automatic,
		voiceChance: Number(options.voiceChance),
		stickerChance: Number(options.stickerChance),
		delayMs: options.delayMs
	};
};
const sample = (id, purpose) => createHash("sha256").update(JSON.stringify([id, purpose])).digest().readUInt32BE(0) / 4294967296;
const mood = (config, scope) => config.modules?.disabled?.includes("mood") ? 60 : getMoodStore(config).snapshot(scope, moodOptions(config), config.retentionDays).value;
const planExpression = (config, scope, inputId, media) => {
	const options = expressionOptions(config);
	const value = scope.platform && scope.channelId ? mood(config, scope) : 60;
	const automatic = options.automatic && !config.modules?.disabled?.includes("expression");
	const expressiveness = value >= 75 ? 1.25 : value < 45 ? .5 : 1;
	return {
		voice: Boolean(automatic && media?.tts?.voice && sample(inputId, "voice") < Math.min(1, options.voiceChance * expressiveness)),
		sticker: Boolean(automatic && media?.stickerRoot && sample(inputId, "sticker") < Math.min(1, options.stickerChance * expressiveness)),
		delayMs: automatic ? Math.min(3e3, Math.round((options.delayMs[0] + sample(inputId, "delay") * (options.delayMs[1] - options.delayMs[0])) * (value < 45 ? 1.2 : 1))) : 0
	};
};
const automaticVoiceText = (text, limit) => Boolean(text.trim()) && Array.from(text).length <= Math.min(240, limit) && !/```|https?:\/\/|\|.*\||\[沉默\]/u.test(text);
const selectExpressionSticker = (items, text, moodValue, inputId) => {
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
	return items.map((item) => ({
		item,
		score: item.tags.reduce((sum, tag) => sum + (text.includes(tag) ? 3 : related.includes(tag) ? 1 : 0), 0),
		tie: sample(inputId, item.id)
	})).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.tie - b.tie)[0]?.item;
};
const moodGroupPolicy = (config, scope, policy) => {
	if (!scope.platform || config.modules?.disabled?.includes("mood")) return policy;
	const value = mood(config, scope);
	return value < 45 ? {
		...policy,
		cooldownSeconds: Math.min(86400, Math.ceil(policy.cooldownSeconds * (value < 25 ? 2 : 1.5)))
	} : policy;
};

export { automaticVoiceText, expressionOptions, moodGroupPolicy, planExpression, selectExpressionSticker };