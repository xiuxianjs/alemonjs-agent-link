import { aiDisabledMessage } from "../../dsh/ai-switch.js";
import { budgetNoticeActions } from "../../billing/help.js";
import { extractPrompt, extractWakePrompt, startsWithAddressName } from "./util.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SessionRegistry } from "../../state/registry.js";
import { toUserMessage } from "../../dsh/client.js";
import { readMessageContext } from "../../social/message-context.js";
import { wakeNamesFor } from "../../social/group-settings.js";
import { groupConversations, scopedGroupPolicy } from "../../social/groups.js";
import { messageReferences } from "../../social/references.js";
import { noticeBubble } from "../bubble.js";
import { respondToGroupBatch } from "../../social/respond.js";
import { logger, useEvent, useMedia, useMessage } from "alemonjs";

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
	const messageContext = await readMessageContext(event, "ambient");
	const selfMention = messageContext.mentions.find((item) => item.isSelf === true);
	const mentionedBot = selfMention ? {
		UserId: selfMention.id,
		UserName: selfMention.name || void 0
	} : void 0;
	const references = await messageReferences.prepare(event);
	const referenceContext = references.context;
	let prompt;
	try {
		prompt = mentionedBot ? extractPrompt(String(event.MessageText ?? ""), mentionedBot) : messageContext.mentionedSelf ? String(event.MessageText || "") : extractWakePrompt(event.MessageText, wakeNamesFor(getDSHConfig(), event.ChannelId || "", event.Platform || ""));
		messageContext.trigger = messageContext.mentionedSelf || mentionedBot ? "mention" : prompt !== null ? "wake_name" : "ambient";
		if (prompt === null && references.quotedBot) {
			messageContext.trigger = "quote";
			prompt = event.MessageText || "用户引用了你的消息，请结合原文回应。";
		}
	} catch (error) {
		await message.send({ format: noticeBubble(toUserMessage(error), {
			platform: event.Platform,
			title: "服务提示",
			actions: [{
				label: "密钥配置",
				command: "/密钥配置"
			}, ...budgetNoticeActions(false)]
		}) });
		return;
	}
	if (prompt !== null && !prompt && !event.MessageMedia?.length && !referenceContext) prompt = "用户 @ 了你，没有附带文字。";
	const reply = async (text, actions = []) => await message.send({ format: noticeBubble(text, {
		platform: event.Platform,
		title: "群聊",
		actions
	}) });
	if (prompt === "/new" || prompt === "/新会话") {
		await reply("请直接发送 /新会话 开始新的群会话。", [{
			label: "新会话",
			command: "/新会话"
		}]);
		return;
	}
	const text = String(event.MessageText || "").trim();
	if (!event.ChannelId || !text && !event.MessageMedia?.length && !referenceContext || text.startsWith("/")) {
		await Promise.resolve(next());
		return;
	}
	const config = getDSHConfig();
	if (config.aiEnabled === false) {
		if (await new SessionRegistry(config).claimDisabledNotice(event.Platform || "", event.ChannelId, false)) await message.send({ format: noticeBubble(aiDisabledMessage(config), {
			platform: event.Platform,
			title: "AI 已关闭",
			actions: [{
				label: "服务状态",
				command: "/状态"
			}, {
				label: "管理说明",
				command: "/帮助 管理"
			}]
		}) });
		return;
	}
	const [media] = useMedia();
	try {
		const localAddress = Boolean(messageContext.mentionedSelf || mentionedBot || messageContext.trigger === "quote" || startsWithAddressName(text, wakeNamesFor(config, event.ChannelId || "", event.Platform || "")));
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
			addressed: localAddress,
			explicitMention: Boolean(messageContext.mentionedSelf || mentionedBot),
			controlText: mentionedBot ? prompt : void 0,
			media: references.media,
			referenceContext,
			forwardIds: event._ForwardIds,
			messageContext
		}, scopedGroupPolicy(event.ChannelId, event.Platform), (batch) => respondToGroupBatch(event, {
			message,
			media
		}, batch))).mode === "none") await Promise.resolve(next());
	} catch (error) {
		logger.warn({ err: error }, "Group conversation scheduling failed");
		if (prompt !== null) await reply("糟糕，网线断了。");
		else await Promise.resolve(next());
	}
};

export { res_default as default };