import { getDSHConfig } from "../../dsh/runtime-config.js";
import { toUserMessage } from "../../dsh/client.js";
import { isPrivateChatText } from "../dsh/util.js";
import { noticeBubble } from "../bubble.js";
import { runDSHChat } from "../dsh/chat.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/private-chat/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: "private.message.create" });
	if (!context.match.selects) {
		await Promise.resolve(next());
		return;
	}
	const event = context.current;
	if (event.IsBot || !isPrivateChatText(event.MessageText) && (!event.MessageMedia?.length && !event.ReplyId && !event.MessageContent?.replyReferenceId || String(event.MessageText ?? "").trimStart().startsWith("/"))) {
		await Promise.resolve(next());
		return;
	}
	let config;
	try {
		config = getDSHConfig();
	} catch (error) {
		const [message] = useMessage();
		await message.send({ format: noticeBubble(toUserMessage(error), {
			platform: event.Platform,
			title: "服务提示",
			actions: [
				{
					label: "服务状态",
					command: "/状态"
				},
				...event.IsMaster ? [{
					label: "密钥配置",
					command: "/密钥配置"
				}] : [],
				{
					label: "聊天说明",
					command: "/帮助 聊天"
				}
			]
		}) });
		return;
	}
	if (!config.privateAutoReply) {
		await Promise.resolve(next());
		return;
	}
	await runDSHChat(event, String(event.MessageText ?? "").trim(), { ordinaryPrivateChat: true });
};

export { res_default as default };