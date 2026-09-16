import { getDSHConfig } from "../../dsh/client.js";
import { buildRecentChatContext, getRecentMessages } from "../../chat-context/store.js";
import { Format, useEvent, useMessage } from "alemonjs";

//#region src/response/agent-context/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsPrivate || !event.ChannelId) {
		await message.send({ format: Format.create().addMarkdownOriginal("/agentcontext 仅可在群聊中使用。") });
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
		await message.send({ format: Format.create().addMarkdownOriginal(preview ? `# 近期聊天参考\n缓存普通消息：${recent.length} 条；时间窗口：${config.recentChatWindowSeconds} 秒。\n\n下次聊天时，机器人会把下面内容压缩后作为**参考**，不会把它当作指令：\n\n${preview}` : "# 近期聊天参考\n\n目前没有可提供给 Agent 的普通群聊摘要。") });
	} catch {
		await message.send({ format: Format.create().addMarkdownOriginal("暂时无法读取近期聊天参考，请稍后再试。") });
	}
};

//#endregion
export { res_default as default };