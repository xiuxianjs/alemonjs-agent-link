import { getDSHConfig } from "../../dsh/runtime-config.js";
import { conversationQueueScope } from "../../dsh/conversation-scope.js";
import "../../dsh/client.js";
import { canManageConversation } from "../dsh/util.js";
import { compressRecentMessages, getRecentMessages } from "../../chat-context/store.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-context/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsPrivate || !event.ChannelId) {
		await message.send({ format: commandBubble("/聊天参考 仅可在群聊中使用。", "近期聊天参考", {
			platform: event.Platform,
			actions: [{
				label: "帮助",
				command: "/帮助 聊天"
			}]
		}) });
		return;
	}
	try {
		const config = getDSHConfig();
		const recent = await getRecentMessages(event.ChannelId, {
			maxMessages: config.recentChatMaxMessages,
			windowSeconds: config.recentChatWindowSeconds,
			maxChars: config.recentChatMaxChars
		}, config, event.MessageId, conversationQueueScope(config, {
			platform: event.Platform,
			botId: event.BotId
		}));
		const previewBudget = Math.max(0, Math.min(config.recentChatSummaryMaxChars, Math.max(80, config.maxMessageLength - 220)));
		const preview = compressRecentMessages(recent, previewBudget).map((item) => `· ${item.text}`).join("\n");
		await message.send({ format: commandBubble(preview ? `本群近期参考摘录（已压缩，并非完整聊天记录）\n${preview}` : "暂无近期聊天参考。", "近期聊天参考", {
			platform: event.Platform,
			actions: [{
				label: "刷新参考",
				command: "/聊天参考"
			}, ...await canManageConversation(event) ? [{
				label: "清除参考",
				command: "/聊天参考 清除"
			}] : []]
		}) });
	} catch {
		await message.send({ format: commandBubble("聊天参考暂不可用，请稍后重试。", "近期聊天参考", {
			platform: event.Platform,
			actions: [{
				label: "重新查看",
				command: "/聊天参考"
			}]
		}) });
	}
};

export { res_default as default };