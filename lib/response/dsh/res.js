import { getDSHConfig } from "../../dsh/runtime-config.js";
import { toUserMessage } from "../../dsh/client.js";
import { groupConversations, scopedGroupPolicy } from "../../social/groups.js";
import { messageReferences } from "../../social/references.js";
import { extractPrompt, extractWakePrompt } from "./util.js";
import { respondToGroupBatch } from "../../social/respond.js";
import { Format, logger, useEvent, useMedia, useMention, useMessage } from "alemonjs";

// src/response/dsh/res.ts
var res_default = async () => {
	const [eventContext, next] = useEvent({ selects: "message.create" });
	if (!eventContext.match.selects) {
		await Promise.resolve(next());
		return;
	}
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsBot || event.IsPrivate) {
		await Promise.resolve(next());
		return;
	}
	const [mention] = useMention();
	const mentionedBot = await mention.findOne({ IsBot: true });
	const references = await messageReferences.prepare(event);
	const referenceContext = references.context;
	let prompt;
	try {
		prompt = mentionedBot.data ? extractPrompt(String(event.MessageText ?? ""), mentionedBot.data) : event.IsAtMe ? String(event.MessageText || "") : extractWakePrompt(event.MessageText, getDSHConfig().groupWakeNames);
		if (prompt === null && references.quotedBot) prompt = event.MessageText || "用户引用了你的消息，请结合原文回应。";
	} catch (error) {
		await message.send({ format: Format.create().addText(toUserMessage(error)) });
		return;
	}
	if (prompt !== null && !prompt && !event.MessageMedia?.length && !referenceContext) prompt = "用户 @ 了你，没有附带文字。";
	const reply = async (text) => await message.send({ format: Format.create().addMarkdownOriginal(text) });
	if (prompt === "/new") {
		await reply("请直接发送 /new 开始新的群会话。");
		return;
	}
	const text = String(event.MessageText || "").trim();
	if (!event.ChannelId || !text && !event.MessageMedia?.length && !referenceContext || text.startsWith("/")) {
		await Promise.resolve(next());
		return;
	}
	const [media] = useMedia();
	try {
		if ((await groupConversations.receive({
			channelId: event.ChannelId,
			platform: event.Platform,
			id: event.MessageId,
			userId: event.UserId,
			userKey: event.UserKey || event.UserId,
			name: (event.UserName || "").slice(0, 80),
			owner: Boolean(event.IsMaster),
			text: text || prompt || "",
			direct: prompt !== null,
			media: references.media,
			referenceContext
		}, scopedGroupPolicy(event.ChannelId, event.Platform), (batch) => respondToGroupBatch(event, {
			message,
			media
		}, batch))).mode === "none") await Promise.resolve(next());
	} catch (error) {
		logger.warn({ err: error }, "Group conversation scheduling failed");
		if (prompt !== null) await reply("群聊消息暂时无法处理，请稍后重试。");
		else await Promise.resolve(next());
	}
};

export { res_default as default };