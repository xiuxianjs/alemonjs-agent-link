// src/social/group-policy.ts
const groupActivityPresets = {
	quiet: {
		interjectChance: .08,
		cooldownSeconds: 180,
		maxPerHour: 4,
		minRecentMessages: 5,
		minRelevance: .35,
		engagedSeconds: 120,
		burstMax: 6,
		burstWindowSeconds: 120
	},
	balanced: {
		interjectChance: .25,
		cooldownSeconds: 60,
		maxPerHour: 10,
		minRecentMessages: 3,
		minRelevance: .2,
		engagedSeconds: 300,
		burstMax: 8,
		burstWindowSeconds: 120
	},
	active: {
		interjectChance: .45,
		cooldownSeconds: 30,
		maxPerHour: 16,
		minRecentMessages: 2,
		minRelevance: .15,
		engagedSeconds: 600,
		burstMax: 10,
		burstWindowSeconds: 120
	}
};
const defaultGroupChatPolicy = {
	activity: "active",
	enabled: true,
	replyGateEnabled: true,
	boundKeyElevation: true,
	boundKeyTools: true,
	batchWindowMs: 1200,
	maxBatchWaitMs: 4e3,
	maxBatchMessages: 24,
	maxBatchChars: 12e3,
	quietHours: [1, 8],
	timezone: "Asia/Shanghai",
	activeWindowSeconds: 300,
	interests: [
		"吃饭",
		"美食",
		"游戏",
		"动漫",
		"猫",
		"鲸鱼",
		"睡觉",
		"天气",
		"奶茶",
		"表情包"
	],
	...groupActivityPresets.active
};
const checkPolicy = (policy) => {
	const ranges = [
		[
			policy.batchWindowMs,
			0,
			1e4
		],
		[
			policy.maxBatchWaitMs,
			1,
			3e4
		],
		[
			policy.maxBatchMessages,
			1,
			100
		],
		[
			policy.maxBatchChars,
			200,
			5e4
		],
		[
			policy.cooldownSeconds,
			0,
			86400
		],
		[
			policy.maxPerHour,
			0,
			100
		],
		[
			policy.minRecentMessages,
			1,
			100
		],
		[
			policy.activeWindowSeconds,
			1,
			3600
		],
		[
			policy.engagedSeconds,
			0,
			1800
		],
		[
			policy.burstMax,
			1,
			100
		],
		[
			policy.burstWindowSeconds,
			1,
			3600
		]
	];
	if (![
		"quiet",
		"balanced",
		"active"
	].includes(String(policy.activity)) || typeof policy.enabled !== "boolean" || policy.replyGateEnabled !== void 0 && typeof policy.replyGateEnabled !== "boolean" || policy.boundKeyElevation !== void 0 && typeof policy.boundKeyElevation !== "boolean" || policy.boundKeyTools !== void 0 && typeof policy.boundKeyTools !== "boolean" || ranges.some(([value, min, max]) => !Number.isSafeInteger(value) || value < min || value > max) || policy.maxBatchWaitMs < policy.batchWindowMs || !Number.isFinite(policy.interjectChance) || policy.interjectChance < 0 || policy.interjectChance > 1 || !Number.isFinite(policy.minRelevance) || policy.minRelevance < 0 || policy.minRelevance > 1 || !Array.isArray(policy.quietHours) || policy.quietHours.length !== 2 || policy.quietHours.some((hour) => !Number.isInteger(hour) || hour < 0 || hour > 23) || !Array.isArray(policy.interests) || policy.interests.length > 100 || policy.interests.some((word) => typeof word !== "string" || !word.trim() || word.length > 40)) throw new Error("groupChat 配置无效。");
	try {
		new Intl.DateTimeFormat("en", { timeZone: policy.timezone }).format();
	} catch {
		throw new Error("groupChat.timezone 无效。");
	}
	return {
		...policy,
		quietHours: [...policy.quietHours],
		interests: [...policy.interests]
	};
};
const getGroupChatPolicy = (config = {}, channelId = "", settings = {}) => {
	if (!config || typeof config !== "object" || Array.isArray(config) || config.overrides !== void 0 && (!config.overrides || typeof config.overrides !== "object" || Array.isArray(config.overrides))) throw new Error("groupChat 配置无效。");
	const { overrides = {}, ...base } = config;
	const merge = (previous, patch) => {
		const activity = patch.activity ?? previous.activity;
		const base = patch.activity ? {
			...previous,
			...groupActivityPresets[activity]
		} : previous;
		return checkPolicy({
			...base,
			...patch,
			activity
		});
	};
	const merged = merge(merge(defaultGroupChatPolicy, base), settings);
	const locked = Object.keys(base).length ? merge(merged, base) : merged;
	for (const [id, override] of Object.entries(overrides)) {
		if (!id || id.length > 300 || !override || typeof override !== "object" || Array.isArray(override)) throw new Error("groupChat.overrides 配置无效。");
		merge(locked, override);
	}
	return merge(locked, overrides[channelId] || {});
};
const groupTopicRelevance = (texts, interests, memoryScore = 0) => {
	const text = texts.join(" ").toLocaleLowerCase();
	const matches = new Set(interests.filter((word) => text.includes(word.toLocaleLowerCase())));
	return Math.min(1, matches.size * .3 + Math.max(0, Math.min(1, memoryScore)) * .5);
};
const boundKeyGroupPolicy = (policy) => {
	if (policy.boundKeyElevation === false) return policy;
	return {
		...policy,
		boundKey: true,
		replyGateEnabled: false,
		cooldownSeconds: 0,
		maxPerHour: policy.maxPerHour === 0 ? 0 : Math.max(policy.maxPerHour, 60),
		interjectChance: policy.interjectChance === 0 ? 0 : 1,
		minRecentMessages: 1,
		minRelevance: 0,
		engagedSeconds: Math.max(policy.engagedSeconds, 600),
		burstMax: Math.max(policy.burstMax, 12),
		burstWindowSeconds: Math.min(policy.burstWindowSeconds, 60)
	};
};
const isQuietHour = (hour, [from, to]) => from === to ? false : from < to ? hour >= from && hour < to : hour >= from || hour < to;
const decideGroupReply = (input) => {
	const { policy, now, relevance } = input;
	const decision = (reply, mode, reason) => ({
		reply,
		mode,
		reason,
		relevance
	});
	const burst = input.replyTimes.filter((time) => now - time < policy.burstWindowSeconds * 1e3).length;
	if (input.continuation && input.direct) return decision(true, "direct", "继续与当前发言人的对话");
	if (burst >= policy.burstMax && !input.explicit && !(input.owner && input.direct)) return decision(false, "none", "近期发言过多");
	if (input.direct) return decision(true, "direct", "被明确唤醒");
	if (!policy.enabled || policy.interjectChance === 0) return decision(false, "none", "自主参与关闭");
	const hour = Number(new Intl.DateTimeFormat("en", {
		timeZone: policy.timezone,
		hour: "2-digit",
		hourCycle: "h23"
	}).format(now));
	if (isQuietHour(hour, policy.quietHours)) return decision(false, "none", "静默时段");
	if (input.engagedUntil > now && relevance >= policy.minRelevance) return decision(true, "engaged", "继续当前话题");
	if (!input.semantic && relevance < policy.minRelevance) return decision(false, "none", "话题相关度不足");
	const interjections = input.interjectTimes.filter((time) => now - time < 36e5);
	if (interjections.length >= policy.maxPerHour) return decision(false, "none", "已达每小时插话上限");
	if (interjections.length && now - Math.max(...interjections) < policy.cooldownSeconds * 1e3) return decision(false, "none", "插话冷却中");
	if (!input.semantic && input.recentTimes.filter((time) => now - time < policy.activeWindowSeconds * 1e3).length < policy.minRecentMessages) return decision(false, "none", "近期消息不足");
	if (input.semantic) return decision(true, "interject", "等待前置判断");
	const chance = policy.boundKey ? 1 : Math.min(.8, policy.interjectChance * (1 + relevance * 4));
	return (input.random || Math.random)() < chance ? decision(true, "interject", "参与相关话题") : decision(false, "none", "本次不插话");
};

export { boundKeyGroupPolicy, decideGroupReply, defaultGroupChatPolicy, getGroupChatPolicy, groupActivityPresets, groupTopicRelevance, isQuietHour };