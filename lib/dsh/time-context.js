// src/dsh/time-context.ts
/** Runtime clock, independent of the host's local timezone and conversation history. */
const currentTimeContext = (now = Date.now()) => {
	return `【本次请求当前时间】北京时间（Asia/Shanghai，UTC+08:00）：${new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	}).format(now)}。这是本次请求的实时钟表时间。历史对话中的“凌晨”“晚安”“昨天”等只属于当时的语境，不能当作现在；对话可能已间隔数小时或跨天。判断现在的时段以这里为准，不要凭上一次聊天延续时段。用户所在地、实际睡眠时长未知时不要猜测；用户说起床了，可以自然回应，不要仅凭时间质疑其作息。`;
};

export { currentTimeContext };