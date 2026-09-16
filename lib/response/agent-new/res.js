import { getDSHConfig, toUserMessage } from "../../dsh/client.js";
import { canReset, getSessionId } from "../dsh/util.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { Format, logger, useEvent, useMessage } from "alemonjs";

//#region src/response/agent-new/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const reply = async (text) => await message.send({ format: Format.create().addMarkdownOriginal(text) });
	if (event.IsPrivate || !event.ChannelId) {
		await reply("/new 仅可在群聊中使用。");
		return;
	}
	if (!canReset(event)) {
		await reply("你没有权限开始新会话。");
		return;
	}
	const sessionId = getSessionId(event.ChannelId);
	try {
		const config = getDSHConfig();
		await resetGroupSession(event.ChannelId, config);
		await reply("## 已开始新话题\n本群共享的 Agent 会话和近期聊天参考已清空；之后的对话会从新的上下文开始。");
	} catch (error) {
		logger.error({
			err: error,
			sessionId
		}, "DSH session clear failed");
		await reply(toUserMessage(error));
	}
};

//#endregion
export { res_default as default };