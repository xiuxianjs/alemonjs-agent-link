import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getChatArchive } from "../../history/store.js";
import "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/history-clear/res.ts
const confirmations = /* @__PURE__ */ new Map();
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const reply = (text, actions = [{
		label: "隐私说明",
		command: "/隐私说明"
	}]) => message.send({ format: commandBubble(text, "清除聊天记录", {
		platform: event.Platform,
		actions
	}) });
	const config = getDSHConfig();
	if (event.IsPrivate ? !await canPrivateChatWithKey(event, config.privateChatAccess) : !event.IsMaster) {
		await reply("仅可清除自己的私聊记录；群归档需由机器人主人清除。");
		return;
	}
	const channelId = getConversationId(event);
	if (!channelId || !event.Platform || !event.UserId) {
		await reply("无法识别当前会话。");
		return;
	}
	const key = JSON.stringify([
		event.Platform,
		event.BotId || "",
		channelId,
		event.UserId
	]);
	for (const [id, expires] of confirmations) if (expires <= Date.now()) confirmations.delete(id);
	const input = route.rawArgs.map(String).join(" ").trim();
	if (input === "取消") {
		confirmations.delete(key);
		await reply("已取消这次清除，聊天记录未删除。", [{
			label: "隐私说明",
			command: "/隐私说明"
		}]);
		return;
	}
	if (input && !["confirm", "确认"].includes(input)) {
		await reply("没有识别出确认操作。请重新查看清除范围，再选择确认或取消。", [{
			label: "查看清除范围",
			command: "/清除聊天记录"
		}]);
		return;
	}
	if (!input) {
		if (confirmations.size >= 1e3) {
			await reply("请求过多，请稍后重试。");
			return;
		}
		confirmations.set(key, Date.now() + 6e4);
		await reply(`范围：${event.IsPrivate ? "本人私聊" : "当前群聊"}\n将永久删除聊天归档，保留长期记忆和当前对话。新消息仍会继续记录。\n请本人在60秒内确认；不确定可以取消。`, [{
			label: "确认删除归档",
			command: "/清除聊天记录 确认"
		}, {
			label: "取消清除",
			command: "/清除聊天记录 取消"
		}]);
		return;
	}
	if ((confirmations.get(key) ?? 0) <= Date.now()) {
		await reply("这次确认已失效。请重新查看清除范围，再于60秒内确认。", [{
			label: "重新查看范围",
			command: "/清除聊天记录"
		}]);
		return;
	}
	confirmations.delete(key);
	try {
		getChatArchive(config).purge({
			platform: event.Platform,
			channelId,
			botId: event.BotId || ""
		});
		await reply("聊天记录已清除，新消息仍会记录。");
	} catch {
		await reply("归档删除失败，请稍后重新查看清除范围再试。", [{
			label: "重新查看范围",
			command: "/清除聊天记录"
		}, {
			label: "隐私说明",
			command: "/隐私说明"
		}]);
	}
};

export { res_default as default };