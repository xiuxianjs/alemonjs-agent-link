import { getDSHConfig } from "../../dsh/client.js";
import { purgeGroupSession } from "../../dsh/orchestrator.js";
import { Format, logger, useEvent, useMessage, useRoute } from "alemonjs";

//#region src/response/agent-purge/res.ts
const confirmationTtlMs = 6e4;
const confirmations = /* @__PURE__ */ new Map();
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	if (event.IsPrivate) {
		await message.send({ format: Format.create().addMarkdownOriginal("请到需要清理的目标群里使用 `/agentpurge`。") });
		return;
	}
	if (!event.ChannelId || !event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人可清除当前群的 Agent 数据。") });
		return;
	}
	const actor = event.UserKey || "master";
	const confirmation = confirmations.get(event.ChannelId);
	if (!(String(route.rawArgs[0] ?? "").toLowerCase() === "confirm")) {
		confirmations.set(event.ChannelId, {
			actor,
			expiresAt: Date.now() + confirmationTtlMs
		});
		await message.send({ format: Format.create().addMarkdownOriginal("## 即将彻底删除本群数据\n会删除 Agent 会话、工作区和近期聊天参考，且无法恢复。\n\n请由你本人在 **60 秒内** 发送：`/agentpurge confirm`") });
		return;
	}
	if (confirmation?.actor !== actor || (confirmation?.expiresAt ?? 0) < Date.now()) {
		confirmations.delete(event.ChannelId);
		await message.send({ format: Format.create().addMarkdownOriginal("确认已过期或不匹配。请先重新发送 `/agentpurge`。") });
		return;
	}
	confirmations.delete(event.ChannelId);
	try {
		const config = getDSHConfig();
		await purgeGroupSession(event.ChannelId, config);
		await message.send({ format: Format.create().addMarkdownOriginal("## 已删除\n当前群的 Agent 会话、工作区与近期聊天参考已彻底清除。") });
	} catch (error) {
		logger.error({ err: error }, "Agent group data purge failed");
		await message.send({ format: Format.create().addMarkdownOriginal("操作暂时未完成，请稍后再试。") });
	}
};

//#endregion
export { res_default as default };