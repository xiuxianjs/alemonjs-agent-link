import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { buildRecentChatContext, getRecentMessages } from "../../chat-context/store.js";
import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-context/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsPrivate || !event.ChannelId) {
		await message.send({ format: Format.create().addMarkdownOriginal("/聊天参考 仅可在群聊中使用。") });
		return;
	}
	try {
		const config = getDSHConfig();
		const recent = await getRecentMessages(event.ChannelId, {
			maxMessages: config.recentChatMaxMessages,
			windowSeconds: config.recentChatWindowSeconds,
			maxChars: config.recentChatMaxChars
		}, config, event.MessageId);
		const previewBudget = Math.max(0, Math.min(config.recentChatSummaryMaxChars, config.maxMessageLength - 320));
		const preview = buildRecentChatContext(recent, previewBudget);
		await message.send({ format: Format.create().addMarkdownOriginal(preview ? `# 近期聊天参考\n以下是当前对话的近期参考：\n\n${preview}` : "# 近期聊天参考\n\n目前没有近期聊天参考。") });
	} catch {
		await message.send({ format: Format.create().addMarkdownOriginal("暂时无法读取近期聊天参考，请稍后再试。") });
	}
};

export { res_default as default };