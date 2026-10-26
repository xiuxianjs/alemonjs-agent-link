import { groupConversations } from "../../social/groups.js";
import { getConversationId } from "../dsh/util.js";
import { cancelChatForUser } from "../../dsh/orchestrator.js";
import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-cancel/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const channelId = getConversationId(event);
	if (!channelId) return;
	const userKey = event.UserKey || event.UserId || "unknown";
	const privileged = event.IsMaster || Boolean(event.IsAdmin);
	let result = cancelChatForUser(channelId, userKey, privileged);
	const cancelledPending = groupConversations.cancelPending(channelId, userKey, privileged);
	if ((result === "empty" || result === "forbidden") && cancelledPending) result = "cancelled-queued";
	const text = {
		"cancelled-running": "已取消正在生成的回复。",
		"cancelled-queued": "已取消你最后一条排队请求。",
		empty: "当前没有正在处理或排队的请求。",
		forbidden: "当前回复属于其他成员；请让发起者取消，或请管理员处理。"
	}[result];
	await message.send({ format: Format.create().addMarkdownOriginal(text) });
};

export { res_default as default };