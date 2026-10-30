import { AdminInputError } from "../panel/admin-error.js";

// src/companion/hobbies.ts
const normalizeHobbies = (raw) => {
	const value = raw === void 0 ? {} : raw;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AdminInputError("爱好设置必须为对象");
	const data = value;
	const keys = [
		"enabled",
		"douyin",
		"bilibili",
		"qzone",
		"interests",
		"autonomous",
		"intervalMinutes",
		"maxPerDay",
		"maxReads"
	];
	if (Object.keys(data).some((key) => !keys.includes(key))) throw new AdminInputError("未知的爱好设置");
	for (const key of [
		"enabled",
		"douyin",
		"bilibili",
		"qzone",
		"autonomous"
	]) if (data[key] !== void 0 && typeof data[key] !== "boolean") throw new AdminInputError("爱好开关必须为布尔值");
	if (data.interests !== void 0 && (typeof data.interests !== "string" || data.interests.length > 1e3)) throw new AdminInputError("兴趣描述最多 1000 字");
	const number = (key, fallback, min, max) => {
		const value = data[key] ?? fallback;
		if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new AdminInputError(`${key} 必须为 ${min}～${max} 的整数`);
		return Number(value);
	};
	return {
		autonomous: data.autonomous === true,
		intervalMinutes: number("intervalMinutes", 120, 15, 1440),
		maxPerDay: number("maxPerDay", 3, 1, 20),
		maxReads: number("maxReads", 1, 1, 3),
		enabled: data.enabled === true,
		douyin: data.douyin === true,
		bilibili: data.bilibili === true,
		qzone: data.qzone === true,
		interests: typeof data.interests === "string" ? data.interests.trim() : ""
	};
};

export { normalizeHobbies };