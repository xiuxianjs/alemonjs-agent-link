import { canManageConversation } from "../dsh/util.js";
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
	if (!eventContext.current.Platform || !eventContext.current.UserId || !eventContext.current.IsPrivate && !eventContext.current.ChannelId) {
		await message.send({ format: noticeBubble("无法识别提问者或当前会话，请重新发送。", {
			platform: eventContext.current.Platform,
			title: "提问",
			actions: [{
				label: "聊天说明",
				command: "/帮助 聊天"
			}]
		}) });
		return;
	}
	if (!prompt && !eventContext.current.MessageMedia?.length && !eventContext.current.ReplyId && !eventContext.current.MessageContent?.replyReferenceId) {
		const canStart = eventContext.current.IsPrivate || await canManageConversation(eventContext.current);
		await message.send({ format: noticeBubble("想问什么？例如：/提问 帮我总结刚才的讨论。", {
			platform: eventContext.current.Platform,
			title: "提问",
			actions: [{
				label: "帮助",
				command: "/帮助 聊天"
			}, ...canStart ? [{
				label: "新会话",
				command: "/新会话"
			}] : []]
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