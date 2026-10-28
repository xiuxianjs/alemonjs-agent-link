import { groupAdminStatus } from "../../platform/member-role.js";

// src/response/dsh/util.ts
const getSessionId = (channelId) => channelId.startsWith("private:") ? `dsh:qq:private:${channelId.slice(8)}` : `dsh:qq:group:${channelId}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const extractPrompt = (messageText, bot) => {
	const patterns = [new RegExp(`^\\s*<@!?${escapeRegExp(bot.UserId)}>\\s*`), new RegExp(`^\\s*\\[CQ:at,qq=${escapeRegExp(bot.UserId)}\\]\\s*`)];
	if (bot.UserName) patterns.push(new RegExp(`^\\s*@${escapeRegExp(bot.UserName)}\\s*`));
	return patterns.reduce((text, pattern) => text.replace(pattern, ""), messageText).trim();
};
const canReset = (event) => event.IsMaster || groupAdminStatus(event) === true;
const getConversationId = (event) => {
	if (!event.IsPrivate) return event.ChannelId || "";
	if (!event.Platform || !event.UserId) return "";
	return `private:${JSON.stringify([event.Platform, event.UserId])}`;
};
const canPrivateChat = (event, access) => Boolean(event.IsMaster) || access === "all";
const canPrivateChatWithKey = async (event, access) => {
	if (canPrivateChat(event, access)) return true;
	if (!event.IsPrivate || !event.Platform || !event.UserId) return false;
	try {
		const [{ withBudgetScope }, { getPersonalCredential }] = await Promise.all([import("../../billing/budget.js"), import("../../credentials/personal.js")]);
		return Boolean(await withBudgetScope({
			platform: event.Platform,
			userId: event.UserId,
			channelId: getConversationId(event)
		}, getPersonalCredential));
	} catch {
		return false;
	}
};
const isPrivateChatText = (text) => typeof text === "string" && Boolean(text.trim()) && !text.trimStart().startsWith("/");
const extractWakePrompt = (text, names) => {
	const input = String(text ?? "").trim();
	if (!input || input.startsWith("/")) return null;
	const normalized = input.toLowerCase();
	for (const name of [...names].sort((a, b) => b.length - a.length)) {
		const keyword = name.toLowerCase();
		const found = /^[a-z0-9 -]+$/iu.test(name) ? new RegExp(`(?<![a-z0-9_])${escapeRegExp(keyword)}(?![a-z0-9_])`, "u").test(normalized) : normalized.includes(keyword);
		if (!name || !found) continue;
		if (normalized === keyword && name !== "帮我") return "用户喊了你一声，请简短回应。";
		if (name !== "帮我" && normalized.startsWith(keyword) && /^[\s，,。！!？?：:、]/u.test(input.slice(name.length))) return input.slice(name.length).replace(/^[\s，,。！!？?：:、]+/u, "").trim() || "用户喊了你一声，请简短回应。";
		return input;
	}
	return null;
};
const describeSpeaker = (event) => JSON.stringify({
	id: event.UserId || "unknown",
	name: (event.UserName || "").slice(0, 80),
	owner: Boolean(event.IsMaster)
});

export { canPrivateChat, canPrivateChatWithKey, canReset, describeSpeaker, extractPrompt, extractWakePrompt, getConversationId, getSessionId, isPrivateChatText };