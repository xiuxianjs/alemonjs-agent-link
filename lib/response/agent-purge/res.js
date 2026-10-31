import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { purgeGroupSession } from "../../dsh/orchestrator.js";
import { commandBubble } from "../bubble.js";
import { logger, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-purge/res.ts
const confirmationTtlMs = 6e4;
const confirmations = /* @__PURE__ */ new Map();
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	if (event.IsPrivate) {
		await message.send({ format: commandBubble("请到需要清理的目标群里使用 /清除群数据。", "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "隐私说明",
				command: "/隐私说明"
			}]
		}) });
		return;
	}
	if (!event.ChannelId || !event.IsMaster) {
		await message.send({ format: commandBubble("仅机器人主人可清除群数据。", "清除群数据", { platform: event.Platform }) });
		return;
	}
	if (!event.Platform || !event.UserId) {
		await message.send({ format: commandBubble("无法确认身份与平台，请重新发送。", "清除群数据", { platform: event.Platform }) });
		return;
	}
	const key = JSON.stringify([
		event.Platform,
		event.BotId || "",
		event.ChannelId,
		event.UserId
	]);
	const input = route.rawArgs.map(String).join(" ").trim();
	for (const [id, expires] of confirmations) if (expires <= Date.now()) confirmations.delete(id);
	if (input === "取消") {
		confirmations.delete(key);
		await message.send({ format: commandBubble("已取消本次清理，群数据未删除。", "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "群设置",
				command: "/群设置"
			}, {
				label: "隐私说明",
				command: "/隐私说明"
			}]
		}) });
		return;
	}
	if (input && !["confirm", "确认"].includes(input)) {
		await message.send({ format: commandBubble("没有识别出确认操作，请重新查看清理范围。", "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "查看清理范围",
				command: "/清除群数据"
			}]
		}) });
		return;
	}
	if (!input) {
		if (confirmations.size >= 1e3) {
			await message.send({ format: commandBubble("等待确认的操作较多，请稍后重试。", "清除群数据", { platform: event.Platform }) });
			return;
		}
		confirmations.set(key, Date.now() + confirmationTtlMs);
		await message.send({ format: commandBubble(`清理群编号：${event.ChannelId}\n将永久删除此群编号的会话、文件、聊天记录、记忆、相关问答、人格选择、表达方式与心情等状态，无法恢复。\n范围包括本服务中其他平台或机器人身份下的相同群编号。全局人格模板、人设细节、群设置及钥匙授权保留。\n请本人在60秒内确认，不确定可取消。`, "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "确认清除",
				command: "/清除群数据 确认",
				choice: "binary"
			}, {
				label: "取消清理",
				command: "/清除群数据 取消",
				choice: "binary"
			}]
		}) });
		return;
	}
	if ((confirmations.get(key) ?? 0) <= Date.now()) {
		confirmations.delete(key);
		await message.send({ format: commandBubble("确认已过期或不匹配。请先重新发送 /清除群数据。", "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "重新发起",
				command: "/清除群数据"
			}]
		}) });
		return;
	}
	confirmations.delete(key);
	try {
		const config = getDSHConfig();
		await purgeGroupSession(event.ChannelId, config);
		await message.send({ format: commandBubble("此群编号的会话数据已清除。群设置、人设细节、钥匙授权及全局人格模板保留。", "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "查看群设置",
				command: "/群设置"
			}, {
				label: "隐私说明",
				command: "/隐私说明"
			}]
		}) });
	} catch (error) {
		logger.error({ err: error }, "Agent group data purge failed");
		await message.send({ format: commandBubble("清理未完成，部分数据可能已经删除。请核对范围后重新发起清理。", "清除群数据", {
			platform: event.Platform,
			actions: [{
				label: "重试清除",
				command: "/清除群数据"
			}]
		}) });
	}
};

export { res_default as default };