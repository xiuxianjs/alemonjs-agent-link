import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getChatArchive } from "../../history/store.js";
import "../../dsh/client.js";
import { canPrivateChat, getConversationId } from "../dsh/util.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/history-clear/res.ts
const confirmations = /* @__PURE__ */ new Map();
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const reply = (text) => message.send({ format: Format.create().addText(text) });
	const config = getDSHConfig();
	if (event.IsPrivate ? !canPrivateChat(event, config.privateChatAccess) : !event.IsMaster) {
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
		channelId,
		event.UserId
	]);
	for (const [id, expires] of confirmations) if (expires <= Date.now()) confirmations.delete(id);
	if (route.rawArgs[0] !== "confirm") {
		if (confirmations.size >= 1e3) {
			await reply("请求过多，请稍后重试。");
			return;
		}
		confirmations.set(key, Date.now() + 6e4);
		await reply("将永久删除当前会话的聊天记录，保留记忆和当前对话。\n60秒内发送 /清除聊天记录 confirm 确认。");
		return;
	}
	if ((confirmations.get(key) ?? 0) <= Date.now()) {
		await reply("请先发送 /清除聊天记录，再于60秒内确认。");
		return;
	}
	confirmations.delete(key);
	try {
		getChatArchive(config).purge({
			platform: event.Platform,
			channelId
		});
		await reply("聊天记录已清除，新消息仍会记录。");
	} catch {
		await reply("归档删除失败，请稍后重试。");
	}
};

export { res_default as default };