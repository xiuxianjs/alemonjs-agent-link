import { clearRecentMessages } from "../../chat-context/store.js";
import { canReset } from "../dsh/util.js";
import { Format, useEvent, useMessage } from "alemonjs";

//#region src/response/agent-context-clear/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsPrivate || !event.ChannelId) {
		await message.send({ format: Format.create().addMarkdownOriginal("/agentcontext clear 仅可在群聊中使用。") });
		return;
	}
	if (!canReset(event)) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人或群管理员可以清除近期上下文。") });
		return;
	}
	await clearRecentMessages(event.ChannelId, getDSHConfig());
	await message.send({ format: Format.create().addMarkdownOriginal("已清除近期聊天参考；当前群的正式 Agent 会话仍会保留。") });
};

//#endregion
export { res_default as default };