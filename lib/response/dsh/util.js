// src/response/dsh/util.ts
const getSessionId = (channelId) => channelId.startsWith("private:") ? `dsh:qq:private:${channelId.slice(8)}` : `dsh:qq:group:${channelId}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const extractPrompt = (messageText, bot) => {
	const patterns = [new RegExp(`^\\s*<@!?${escapeRegExp(bot.UserId)}>\\s*`), new RegExp(`^\\s*\\[CQ:at,qq=${escapeRegExp(bot.UserId)}\\]\\s*`)];
	if (bot.UserName) patterns.push(new RegExp(`^\\s*@${escapeRegExp(bot.UserName)}\\s*`));
	return patterns.reduce((text, pattern) => text.replace(pattern, ""), messageText).trim();
};
const canReset = (event) => event.IsMaster || Boolean(event.IsAdmin);
const getConversationId = (event) => {
	if (!event.IsPrivate) return event.ChannelId || "";
	if (!event.Platform || !event.UserId) return "";
	return `private:${JSON.stringify([event.Platform, event.UserId])}`;
};
const canPrivateChat = (event, access) => Boolean(event.IsMaster) || access === "all";
const isPrivateChatText = (text) => typeof text === "string" && Boolean(text.trim()) && !text.trimStart().startsWith("/");
const extractWakePrompt = (text, names) => {
	const input = String(text ?? "").trim();
	if (!input || input.startsWith("/")) return null;
	for (const name of [...names].sort((a, b) => b.length - a.length)) {
		if (!name || !input.includes(name)) continue;
		if (input === name && name !== "帮我") return "用户喊了你一声，请简短回应。";
		if (name !== "帮我" && input.startsWith(name) && /^[\s，,。！!？?：:、]/u.test(input.slice(name.length))) return input.slice(name.length).replace(/^[\s，,。！!？?：:、]+/u, "").trim() || "用户喊了你一声，请简短回应。";
		return input;
	}
	return null;
};
const describeSpeaker = (event) => JSON.stringify({
	id: event.UserId || "unknown",
	name: (event.UserName || "").slice(0, 80),
	owner: Boolean(event.IsMaster)
});

export { canPrivateChat, canReset, describeSpeaker, extractPrompt, extractWakePrompt, getConversationId, getSessionId, isPrivateChatText };