import { getDSHConfig } from "../../dsh/runtime-config.js";
import { conversationQueueScope } from "../../dsh/conversation-scope.js";
import { groupConversations } from "../../social/groups.js";
import { canManageConversation, getConversationId } from "../dsh/util.js";
import { cancelChatForUser } from "../../dsh/orchestrator.js";
import { noticeBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-cancel/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const channelId = getConversationId(event);
	const reply = (text) => message.send({ format: noticeBubble(text, {
		platform: event.Platform,
		title: "取消提问",
		actions: [{
			label: "重新提问",
			command: "/提问"
		}, {
			label: "聊天说明",
			command: "/帮助 聊天"
		}]
	}) });
	if (!channelId || !event.UserKey && !event.UserId) {
		await reply("无法识别当前会话或提问者，请重新发送。");
		return;
	}
	if (route.rawArgs.length) {
		await message.send({ format: noticeBubble("取消提问不需要附加内容。请使用下方入口；清除数据等操作须使用各自的取消入口。", {
			platform: event.Platform,
			title: "取消提问",
			actions: [{
				label: "取消提问",
				command: "/取消"
			}, {
				label: "聊天说明",
				command: "/帮助 聊天"
			}]
		}) });
		return;
	}
	try {
		const userKey = event.UserKey || event.UserId || "unknown";
		const privileged = await canManageConversation(event);
		let result = cancelChatForUser(channelId, userKey, privileged, conversationQueueScope(getDSHConfig(), {
			platform: event.Platform,
			botId: event.BotId
		}));
		const cancelledPending = groupConversations.cancelPending(channelId, userKey, privileged, {
			platform: event.Platform,
			botId: event.BotId
		});
		if ((result === "empty" || result === "forbidden") && cancelledPending) result = "cancelled-queued";
		const text = {
			"cancelled-running": `好，这条我不继续写了。${cancelledPending ? "相关的待处理消息和等待回复也已取消。" : ""}`,
			"cancelled-queued": cancelledPending ? "待处理的消息和等待回复已取消。" : "最后一条排队的提问已撤回。",
			empty: "现在没有待处理的提问了。",
			forbidden: "这是其他成员的提问，需要由本人或管理员来取消。"
		}[result];
		await reply(text);
	} catch {
		await message.send({ format: noticeBubble("暂时无法确认是否取消成功。请先查看状态，再决定是否重新提问。", {
			platform: event.Platform,
			title: "取消提问",
			actions: [{
				label: "服务状态",
				command: "/状态"
			}, {
				label: "聊天说明",
				command: "/帮助 聊天"
			}]
		}) });
	}
};

export { res_default as default };