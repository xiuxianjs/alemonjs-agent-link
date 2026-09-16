import { runDSHChat } from "../dsh/chat.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

//#region src/response/agent-chat/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const prompt = route.rawArgs.join(" ").trim();
	const [message] = useMessage();
	if (eventContext.current.IsPrivate && !eventContext.current.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("仅机器人主人可在私聊中使用 `/chat`。") });
		return;
	}
	if (!eventContext.current.IsPrivate && !eventContext.current.ChannelId) return;
	if (!prompt) {
		await message.send({ format: Format.create().addMarkdownOriginal("想问什么？例如：`/chat 帮我总结刚才的讨论`。") });
		return;
	}
	await runDSHChat(eventContext.current, prompt);
};

//#endregion
export { res_default as default };