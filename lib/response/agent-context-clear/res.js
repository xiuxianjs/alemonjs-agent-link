import { conversationQueueScope } from "../../dsh/conversation-scope.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { canReset } from "../dsh/util.js";
import { clearRecentMessages } from "../../chat-context/store.js";
import { noticeBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-context-clear/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (event.IsPrivate || !event.ChannelId) {
		await message.send({ format: noticeBubble("/聊天参考 清除 仅可在群聊中使用。", {
			platform: event.Platform,
			title: "聊天参考"
		}) });
		return;
	}
	if (!canReset(event)) {
		await message.send({ format: noticeBubble("仅主人或群管理员可清除聊天参考。", {
			platform: event.Platform,
			title: "聊天参考",
			actions: [{
				label: "帮助",
				command: "/帮助 聊天"
			}]
		}) });
		return;
	}
	const config = getDSHConfig();
	await clearRecentMessages(event.ChannelId, config, conversationQueueScope(config, {
		platform: event.Platform,
		botId: event.BotId
	}));
	await message.send({ format: noticeBubble("聊天参考已清除，正式对话保留。", {
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
};

export { res_default as default };