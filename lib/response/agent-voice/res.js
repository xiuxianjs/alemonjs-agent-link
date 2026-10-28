import { noticeBubble } from "../bubble.js";
import { runDSHChat } from "../dsh/chat.js";
import { submitGroupChat } from "../../social/respond.js";
import { useEvent, useMedia, useMessage, useRoute } from "alemonjs";

// src/response/agent-voice/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched || context.current.IsBot) return;
	const text = route.rawArgs.join(" ").trim();
	if (!text && !context.current.MessageMedia?.length && !context.current.ReplyId && !context.current.MessageContent?.replyReferenceId) {
		const [message] = useMessage();
		await message.send({ format: noticeBubble("用法：/语音 你的问题（不可用时回退文字）", {
			platform: context.current.Platform,
			title: "语音",
			actions: [{
				label: "语音用法",
				command: "/帮助 媒体"
			}]
		}) });
		return;
	}
	if (context.current.IsPrivate) await runDSHChat(context.current, text, { voice: true });
	else {
		const [message] = useMessage();
		const [media] = useMedia();
		try {
			await submitGroupChat(context.current, text, {
				message,
				media
			}, true);
		} catch {
			await message.send({ format: noticeBubble("群聊消息暂时无法处理，请稍后重试。", {
				platform: context.current.Platform,
				title: "暂时不可用",
				actions: [{
					label: "服务状态",
					command: "/状态"
				}, {
					label: "帮助",
					command: "/帮助 媒体"
				}]
			}) });
		}
	}
};

export { res_default as default };