import { getDSHConfig, toUserMessage } from "../../dsh/client.js";
import { extractPrompt, extractWakePrompt } from "./util.js";
import { runDSHChat } from "./chat.js";
import { Format, useEvent, useMention, useMessage } from "alemonjs";

// src/response/dsh/res.ts
var res_default = async () => {
	const [eventContext, next] = useEvent({ selects: "message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsBot || event.IsPrivate) {
		await Promise.resolve(next());
		return;
	}
	const [mention] = useMention();
	const mentionedBot = await mention.findOne({ IsBot: true });
	let prompt;
	try {
		prompt = mentionedBot.data ? extractPrompt(String(event.MessageText ?? ""), mentionedBot.data) : extractWakePrompt(event.MessageText, getDSHConfig().groupWakeNames);
	} catch (error) {
		await message.send({ format: Format.create().addText(toUserMessage(error)) });
		return;
	}
	if (prompt === null) {
		await Promise.resolve(next());
		return;
	}
	if (!prompt && !event.MessageMedia?.length) {
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

export { res_default as default };