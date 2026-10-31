import { getDSHConfig } from "../../dsh/runtime-config.js";
import { toUserMessage } from "../../dsh/client.js";
import { canManageConversation, canPrivateChatWithKey, getConversationId, getSessionId } from "../dsh/util.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { noticeBubble } from "../bubble.js";
import { commandExpression } from "../../companion/command-expression.js";
import { logger, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-new/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const reply = async (text, actions = []) => await message.send({ format: noticeBubble(text, {
		platform: event.Platform,
		title: "新会话",
		actions
	}) });
	const channelId = getConversationId(event);
	if (route.rawArgs.length) {
		await reply("开始新话题不需要附加内容。请先发送下方指令，收到成功提示后再发送新问题。", [{
			label: "开始新话题",
			command: "/新会话"
		}, {
			label: "聊天说明",
			command: "/帮助 聊天"
		}]);
		return;
	}
	if (!channelId) {
		await reply("无法识别当前会话。");
		return;
	}
	if (!event.IsPrivate && !await canManageConversation(event)) {
		await reply("在群里开始新会话，需要管理员或机器人主人来操作。", [{
			label: "我的权限",
			command: "/我的权限"
		}, {
			label: "聊天说明",
			command: "/帮助 聊天"
		}]);
		return;
	}
	const sessionId = getSessionId(channelId);
	try {
		const config = getDSHConfig();
		if (event.IsPrivate && !await canPrivateChatWithKey(event, config.privateChatAccess)) {
			await reply("当前未开放此私聊。", [{
				label: "个人 Key 说明",
				command: "/帮助 额度"
			}]);
			return;
		}
		await resetGroupSession(channelId, config);
		await reply(commandExpression(config, {
			platform: event.Platform,
			channelId
		}, event.IsPrivate ? "好，我们换个话题聊。长期记忆和聊天记录都还在。" : "好，群里接下来从新话题聊起。长期记忆和聊天记录都还在。", event.IsPrivate ? "已开始新话题，长期记忆和聊天记录保留。" : "本群已开始新话题，长期记忆和聊天记录保留。"), [{
			label: "帮助",
			command: "/帮助 聊天"
		}, {
			label: "查看额度",
			command: "/额度"
		}]);
	} catch (error) {
		logger.error({
			err: error,
			sessionId
		}, "DSH session clear failed");
		await reply(toUserMessage(error), [{
			label: "服务状态",
			command: "/状态"
		}, {
			label: "聊天说明",
			command: "/帮助 聊天"
		}]);
	}
};

export { res_default as default };