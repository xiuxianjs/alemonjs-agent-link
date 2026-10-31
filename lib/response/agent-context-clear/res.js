import { getDSHConfig } from "../../dsh/runtime-config.js";
import { conversationQueueScope } from "../../dsh/conversation-scope.js";
import "../../dsh/client.js";
import { canManageConversation } from "../dsh/util.js";
import { clearRecentMessages } from "../../chat-context/store.js";
import { noticeBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-context-clear/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsPrivate || !event.ChannelId) {
		await message.send({ format: noticeBubble("请到需要清除参考的群里操作。这里只清除近期参考，不会删除正式对话。", {
			platform: event.Platform,
			title: "聊天参考",
			actions: [{
				label: "聊天说明",
				command: "/帮助 聊天"
			}]
		}) });
		return;
	}
	if (route.rawArgs.length) {
		await message.send({ format: noticeBubble("清除参考不需要填写内容。请先查看本群参考，再选择清除。", {
			platform: event.Platform,
			title: "聊天参考",
			actions: [{
				label: "查看参考",
				command: "/聊天参考"
			}]
		}) });
		return;
	}
	try {
		if (!await canManageConversation(event)) {
			await message.send({ format: noticeBubble("仅主人或群管理员可清除聊天参考。", {
				platform: event.Platform,
				title: "聊天参考",
				actions: [{
					label: "查看参考",
					command: "/聊天参考"
				}, {
					label: "我的权限",
					command: "/我的权限"
				}]
			}) });
			return;
		}
		const config = getDSHConfig();
		await clearRecentMessages(event.ChannelId, config, conversationQueueScope(config, {
			platform: event.Platform,
			botId: event.BotId
		}));
		await message.send({ format: noticeBubble("本群近期聊天参考已清除，正式对话保留。新的群消息仍会形成新的参考。", {
			platform: event.Platform,
			title: "聊天参考",
			actions: [{
				label: "再次查看",
				command: "/聊天参考"
			}, {
				label: "帮助",
				command: "/帮助 聊天"
			}]
		}) });
	} catch {
		await message.send({ format: noticeBubble("暂时无法确认是否已清除。请先查看本群参考，再决定是否重试。", {
			platform: event.Platform,
			title: "聊天参考",
			actions: [{
				label: "查看参考",
				command: "/聊天参考"
			}]
		}) });
	}
};

export { res_default as default };