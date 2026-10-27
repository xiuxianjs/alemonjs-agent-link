import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { purgeGroupSession } from "../../dsh/orchestrator.js";
import { Format, logger, useEvent, useMessage, useRoute } from "alemonjs";

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
		await message.send({ format: Format.create().addMarkdownOriginal("请到需要清理的目标群里使用 `/清除群数据`。") });
		return;
	}
	if (!event.ChannelId || !event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("仅机器人主人可清除群数据。") });
		return;
	}
	const actor = event.UserKey || "master";
	const confirmation = confirmations.get(event.ChannelId);
	if (!["confirm", "确认"].includes(String(route.rawArgs[0] ?? "").toLowerCase())) {
		confirmations.set(event.ChannelId, {
			actor,
			expiresAt: Date.now() + confirmationTtlMs
		});
		await message.send({ format: Format.create().addMarkdownOriginal("将永久删除本群会话、文件、聊天记录、记忆及本群人格和心情设置，无法恢复。\n请本人在60秒内发送 `/清除群数据 确认`。") });
		return;
	}
	if (confirmation?.actor !== actor || (confirmation?.expiresAt ?? 0) < Date.now()) {
		confirmations.delete(event.ChannelId);
		await message.send({ format: Format.create().addMarkdownOriginal("确认已过期或不匹配。请先重新发送 `/清除群数据`。") });
		return;
	}
	confirmations.delete(event.ChannelId);
	try {
		const config = getDSHConfig();
		await purgeGroupSession(event.ChannelId, config);
		await message.send({ format: Format.create().addMarkdownOriginal("本群数据已彻底清除。") });
	} catch (error) {
		logger.error({ err: error }, "Agent group data purge failed");
		await message.send({ format: Format.create().addMarkdownOriginal("清理未完成，请核对后重试。") });
	}
};

export { res_default as default };