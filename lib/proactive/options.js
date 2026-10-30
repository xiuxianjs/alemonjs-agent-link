// src/proactive/options.ts
const proactiveActivityPresets = {
	quiet: {
		idleMinutes: 90,
		minIntervalMinutes: 180,
		maxIntervalMinutes: 360,
		maxPerDay: 2,
		nudgeChance: .3,
		maxNudgesPerDay: 1,
		maxUnanswered: 1
	},
	balanced: {
		idleMinutes: 40,
		minIntervalMinutes: 60,
		maxIntervalMinutes: 180,
		maxPerDay: 4,
		nudgeChance: .5,
		maxNudgesPerDay: 4,
		maxUnanswered: 2
	},
	active: {
		idleMinutes: 20,
		minIntervalMinutes: 30,
		maxIntervalMinutes: 90,
		maxPerDay: 8,
		nudgeChance: .6,
		maxNudgesPerDay: 6,
		maxUnanswered: 3
	}
};
const proactiveOptions = (config) => {
	const raw = config.modules?.settings?.proactive || {};
	const activity = raw.activity ?? "active";
	if (![
		"quiet",
		"balanced",
		"active"
	].includes(activity)) throw new Error("proactive 模块设置无效。");
	const options = {
		enabled: raw.enabled ?? true,
		autoSubscribe: raw.autoSubscribe ?? true,
		nudge: raw.nudge ?? true,
		nudgeMinMinutes: raw.nudgeMinMinutes ?? 15,
		nudgeMaxMinutes: raw.nudgeMaxMinutes ?? 40,
		quietHours: raw.quietHours ?? [23, 8],
		timezone: raw.timezone ?? "Asia/Shanghai",
		maxChars: raw.maxChars ?? 300,
		ownKeyMax: raw.ownKeyMax ?? true,
		...proactiveActivityPresets[activity],
		...raw,
		activity
	};
	const ranges = [
		[
			options.idleMinutes,
			1,
			1440
		],
		[
			options.minIntervalMinutes,
			1,
			1440
		],
		[
			options.maxIntervalMinutes,
			1,
			2880
		],
		[
			options.maxPerDay,
			0,
			20
		],
		[
			options.nudgeMinMinutes,
			1,
			1440
		],
		[
			options.nudgeMaxMinutes,
			1,
			2880
		],
		[
			options.maxNudgesPerDay,
			0,
			20
		],
		[
			options.maxUnanswered,
			1,
			20
		],
		[
			options.maxChars,
			40,
			1e3
		]
	];
	if (typeof options.enabled !== "boolean" || typeof options.autoSubscribe !== "boolean" || typeof options.nudge !== "boolean" || typeof options.ownKeyMax !== "boolean" || ranges.some(([value, min, max]) => !Number.isSafeInteger(value) || value < min || value > max) || Number(options.minIntervalMinutes) > Number(options.maxIntervalMinutes) || Number(options.nudgeMinMinutes) >= Number(options.nudgeMaxMinutes) || !Number.isFinite(options.nudgeChance) || Number(options.nudgeChance) < 0 || Number(options.nudgeChance) > 1 || !Array.isArray(options.quietHours) || options.quietHours.length !== 2 || options.quietHours.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 23) || typeof options.timezone !== "string") throw new Error("proactive 模块设置无效。");
	try {
		new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format();
	} catch {
		throw new Error("主动搭话时区无效。");
	}
	return options;
};
const proactiveEnabled = (config) => config.aiEnabled !== false && !config.modules?.disabled?.includes("proactive") && proactiveOptions(config).enabled;
/**
* 绑定个人 Key 的私聊不花机器人额度，主动搭话直接拉满：
* 更快空闲、更多次数、更长连发。免打扰时段与平台限制不在此提权范围内。
*/
const entitledProactiveOptions = (options) => options.ownKeyMax ? {
	...options,
	idleMinutes: Math.min(options.idleMinutes, 20),
	minIntervalMinutes: Math.min(options.minIntervalMinutes, 20),
	maxIntervalMinutes: Math.min(options.maxIntervalMinutes, 45),
	maxPerDay: Math.max(options.maxPerDay, 10),
	nudgeChance: Math.max(options.nudgeChance, .7),
	maxNudgesPerDay: Math.max(options.maxNudgesPerDay, 6),
	maxUnanswered: Math.max(options.maxUnanswered, 3),
	flexible: true
} : options;
const localDay = (now, timezone) => new Intl.DateTimeFormat("en-CA", {
	timeZone: timezone,
	year: "numeric",
	month: "2-digit",
	day: "2-digit"
}).format(now);
const isQuiet = (now, options) => {
	const hour = Number(new Intl.DateTimeFormat("en", {
		timeZone: options.timezone,
		hour: "2-digit",
		hourCycle: "h23"
	}).format(now));
	const [start, end] = options.quietHours;
	return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
};

export { entitledProactiveOptions, isQuiet, localDay, proactiveEnabled, proactiveOptions };