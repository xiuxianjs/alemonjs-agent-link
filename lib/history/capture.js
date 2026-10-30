import { isPersonalKeyCommand } from "../credentials/personal.js";
import { getChatArchive, historyEnabled } from "./store.js";
import { getMemoryStore } from "../memory/store.js";
import { canPrivateChat, getConversationId } from "../response/dsh/util.js";
import { buildMessageContext } from "../social/message-context.js";
import { memoryEnabled } from "../memory/consolidation.js";
import { randomUUID } from "node:crypto";
import { logger } from "alemonjs";

// src/history/capture.ts
const archiveIncoming = (config, event, privateAllowed = false) => {
	if (isPersonalKeyCommand(event.MessageText)) return;
	if (!historyEnabled(config) || event.IsBot || !event.Platform || !event.MessageId || event.IsPrivate && !privateAllowed && !canPrivateChat(event, config.privateChatAccess)) return;
	const channelId = getConversationId(event);
	if (!channelId) return;
	if (/^\/(?:我的主人|我是主人|agentbind)(?:\s|$)/iu.test((event.MessageText || "").trimStart())) return;
	const text = [event.MessageText || "", ...(event.MessageMedia || []).map((item) => `[附件:${item.Type}]`)].filter(Boolean).join("\n");
	try {
		getChatArchive(config).append({
			platform: event.Platform,
			channelId,
			botId: event.BotId || ""
		}, {
			id: event.MessageId,
			role: "user",
			speakerId: event.UserId || "",
			speaker: event.UserName || event.UserId || "未知用户",
			text,
			referenceId: event.MessageContent?.referenceId,
			replyToId: event.MessageContent?.replyReferenceId || event.ReplyId,
			platformIdKnown: true,
			context: buildMessageContext(event, event.MessageMentions, event.IsPrivate ? "private" : "ambient")
		});
	} catch {
		logger.error("聊天历史归档写入失败；当前消息未保存，请检查磁盘和权限。");
		return;
	}
	if (memoryEnabled(config)) try {
		getMemoryStore(config).observe({
			platform: event.Platform,
			channelId,
			botId: event.BotId || ""
		});
	} catch {
		logger.error("聊天记录已归档，但记忆整理范围登记失败。");
	}
};
const archiveReply = (config, event, text, receipt, replyToId) => {
	if (!historyEnabled(config) || !event.Platform) return;
	const channelId = getConversationId(event);
	if (!channelId) return;
	const platformId = receipt && ("id" in receipt ? receipt.id : "messageId" in receipt ? receipt.messageId : void 0);
	const referenceId = receipt && "referenceId" in receipt ? receipt.referenceId : void 0;
	try {
		getChatArchive(config).append({
			platform: event.Platform,
			channelId,
			botId: event.BotId || ""
		}, {
			id: platformId || `local:${randomUUID()}`,
			role: "assistant",
			speakerId: event.BotId || "assistant",
			speaker: "大肥鱼",
			text,
			referenceId,
			replyToId,
			sourceMessageId: event.MessageId,
			platformIdKnown: Boolean(platformId)
		});
	} catch {
		logger.error("聊天历史归档写入失败；本次已发送回复未保存，请检查磁盘和权限。");
	}
};

export { archiveIncoming, archiveReply };