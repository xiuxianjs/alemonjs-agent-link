import { getDSHConfig, toUserMessage } from "../../dsh/client.js";
import { isPrivateChatText } from "../dsh/util.js";
import { runDSHChat } from "../dsh/chat.js";
import { Format, useEvent, useMessage } from "alemonjs";

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
		await message.send({ format: Format.create().addMarkdownOriginal(toUserMessage(error)) });
		return;
	}
	if (!config.privateAutoReply) {
		await Promise.resolve(next());
		return;
	}
	await runDSHChat(event, String(event.MessageText ?? "").trim());
};

export { res_default as default };