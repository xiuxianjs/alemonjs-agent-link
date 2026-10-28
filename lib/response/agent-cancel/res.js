import { canReset, getConversationId } from "../dsh/util.js";
import { groupConversations } from "../../social/groups.js";
import { cancelChatForUser } from "../../dsh/orchestrator.js";
import { noticeBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-cancel/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const channelId = getConversationId(event);
	if (!channelId) return;
	const userKey = event.UserKey || event.UserId || "unknown";
	const privileged = canReset(event);
	let result = cancelChatForUser(channelId, userKey, privileged);
	const cancelledPending = groupConversations.cancelPending(channelId, userKey, privileged);
	if ((result === "empty" || result === "forbidden") && cancelledPending) result = "cancelled-queued";
	const text = {
		"cancelled-running": "已取消正在生成的回复。",
		"cancelled-queued": "已取消你最后一条排队请求。",
		empty: "当前没有待处理请求。",
		forbidden: "这是其他成员的请求，请由本人或管理员取消。"
	}[result];
	await message.send({ format: noticeBubble(text, {
		platform: eventContext.current.Platform,
		title: "取消",
		actions: [{
			label: "重新提问",
			command: "/提问"
		}, {
			label: "帮助",
			command: "/帮助 聊天"
		}]
	}) });
};

export { res_default as default };