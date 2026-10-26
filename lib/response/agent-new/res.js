import { getDSHConfig } from "../../dsh/runtime-config.js";
import { toUserMessage } from "../../dsh/client.js";
import { canPrivateChat, canReset, getConversationId, getSessionId } from "../dsh/util.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { Format, logger, useEvent, useMessage } from "alemonjs";

// src/response/agent-new/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const reply = async (text) => await message.send({ format: Format.create().addMarkdownOriginal(text) });
	const channelId = getConversationId(event);
	if (!channelId) {
		await reply("无法识别当前会话。");
		return;
	}
	if (!event.IsPrivate && !canReset(event)) {
		await reply("你没有权限开始新会话。");
		return;
	}
	const sessionId = getSessionId(channelId);
	try {
		const config = getDSHConfig();
		if (event.IsPrivate && !canPrivateChat(event, config.privateChatAccess)) {
			await reply("仅机器人主人可在私聊中使用 Agent。");
			return;
		}
		await resetGroupSession(channelId, config);
		await reply(event.IsPrivate ? "已开始新话题，你的私聊会话和短期记忆已清空；/记住 保存的长期记忆仍保留。" : "## 已开始新话题\n本群共享的 Agent 会话和近期聊天参考已清空；之后的对话会从新的上下文开始。");
	} catch (error) {
		logger.error({
			err: error,
			sessionId
		}, "DSH session clear failed");
		await reply(toUserMessage(error));
	}
};

export { res_default as default };