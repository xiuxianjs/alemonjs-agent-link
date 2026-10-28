import { noticeBubble } from "../bubble.js";
import { runDSHChat } from "../dsh/chat.js";
import { submitGroupChat } from "../../social/respond.js";
import { useEvent, useMedia, useMessage, useRoute } from "alemonjs";

// src/response/agent-chat/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched || eventContext.current.IsBot) return;
	const prompt = route.rawArgs.join(" ").trim();
	const [message] = useMessage();
	if (!eventContext.current.IsPrivate && !eventContext.current.ChannelId) return;
	if (!prompt && !eventContext.current.MessageMedia?.length && !eventContext.current.ReplyId && !eventContext.current.MessageContent?.replyReferenceId) {
		await message.send({ format: noticeBubble("想问什么？例如：/提问 帮我总结刚才的讨论。", {
			platform: eventContext.current.Platform,
			title: "提问",
			actions: [{
				label: "帮助",
				command: "/帮助 聊天"
			}, {
				label: "新会话",
				command: "/新会话"
			}]
		}) });
		return;
	}
	if (eventContext.current.IsPrivate) await runDSHChat(eventContext.current, prompt);
	else {
		const [media] = useMedia();
		try {
			await submitGroupChat(eventContext.current, prompt, {
				message,
				media
			});
		} catch {
			await message.send({ format: noticeBubble("群聊消息暂时无法处理，请稍后重试。", {
				platform: eventContext.current.Platform,
				title: "暂时不可用",
				actions: [{
					label: "重试提问",
					command: "/提问"
				}, {
					label: "服务状态",
					command: "/状态"
				}]
			}) });
		}
	}
};

export { res_default as default };