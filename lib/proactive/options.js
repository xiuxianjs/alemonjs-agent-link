// src/proactive/options.ts
const proactiveOptions = (config) => {
	const raw = config.modules?.settings?.proactive || {};
	const options = {
		enabled: raw.enabled ?? true,
		idleMinutes: raw.idleMinutes ?? 40,
		minIntervalMinutes: raw.minIntervalMinutes ?? 60,
		maxIntervalMinutes: raw.maxIntervalMinutes ?? 180,
		maxPerDay: raw.maxPerDay ?? 4,
		nudge: raw.nudge ?? true,
		nudgeMinMinutes: raw.nudgeMinMinutes ?? 15,
		nudgeMaxMinutes: raw.nudgeMaxMinutes ?? 40,
		nudgeChance: raw.nudgeChance ?? .5,
		maxNudgesPerDay: raw.maxNudgesPerDay ?? 4,
		maxUnanswered: raw.maxUnanswered ?? 2,
		quietHours: raw.quietHours ?? [23, 8],
		timezone: raw.timezone ?? "Asia/Shanghai",
		maxChars: raw.maxChars ?? 300
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
	if (typeof options.enabled !== "boolean" || typeof options.nudge !== "boolean" || ranges.some(([value, min, max]) => !Number.isSafeInteger(value) || value < min || value > max) || Number(options.minIntervalMinutes) > Number(options.maxIntervalMinutes) || Number(options.nudgeMinMinutes) >= Number(options.nudgeMaxMinutes) || !Number.isFinite(options.nudgeChance) || Number(options.nudgeChance) < 0 || Number(options.nudgeChance) > 1 || !Array.isArray(options.quietHours) || options.quietHours.length !== 2 || options.quietHours.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 23) || typeof options.timezone !== "string") throw new Error("proactive 模块设置无效。");
	try {
		new Intl.DateTimeFormat("en", { timeZone: options.timezone }).format();
	} catch {
		throw new Error("主动搭话时区无效。");
	}
	return options;
};
const proactiveEnabled = (config) => !config.modules?.disabled?.includes("proactive") && proactiveOptions(config).enabled;
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

export { isQuiet, localDay, proactiveEnabled, proactiveOptions };