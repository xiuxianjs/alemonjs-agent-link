import { extractPrompt } from "./util.js";
import { runDSHChat } from "./chat.js";
import { Format, useEvent, useMention, useMessage } from "alemonjs";

//#region src/response/dsh/res.ts
var res_default = async () => {
	const [eventContext, next] = useEvent({ selects: "message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const [mention] = useMention();
	const mentionedBot = await mention.findOne({ IsBot: true });
	if (!mentionedBot.data) {
		await Promise.resolve(next());
		return;
	}
	const prompt = extractPrompt(event.MessageText, mentionedBot.data);
	if (!prompt) {
		await message.send({ format: Format.create().addMarkdownOriginal("想聊什么？直接告诉我，或发送 `/agenthelp` 看看怎么用。") });
		return;
	}
	const reply = async (text) => await message.send({ format: Format.create().addMarkdownOriginal(text) });
	if (prompt === "/new") {
		await reply("请直接发送 /new 开始新的群会话。");
		return;
	}
	await runDSHChat(event, prompt);
};

//#endregion
export { res_default as default };