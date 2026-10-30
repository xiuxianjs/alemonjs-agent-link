import { intelligenceLevels, readIntelligenceLevel, resolveIntelligenceAccess, saveIntelligenceLevel } from "../../agent/intelligence.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-intelligence/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const identity = {
		platform: event.Platform || "",
		channelId: getConversationId(event),
		userId: event.UserId || "",
		owner: Boolean(event.IsMaster),
		private: Boolean(event.IsPrivate),
		admin: !event.IsPrivate && await verifyGroupKeyAdmin(event)
	};
	const config = getDSHConfig();
	let text;
	try {
		const value = route.rawArgs.map(String).join(" ").trim();
		if (value && value !== "状态") await saveIntelligenceLevel(config, identity, value);
		const access = await resolveIntelligenceAccess(identity, config);
		const level = readIntelligenceLevel(config, identity, access.entitled) || access.defaultLevel;
		text = `身份：${identity.owner ? "机器人主人" : identity.admin ? "群管理员" : access.bound && identity.private ? "密钥主人" : "普通用户"}\n当前智能程度：${level} · ${identity.private ? "本人私聊" : "本群"}\n${access.bound ? "费用使用当前会话授权 Key。" : "使用默认服务额度。"}\n智能程度调节多步工具执行预算，仍受服务上限约束。\n绑定自己的 Key，解锁专属能力；群设置由管理员管理，授权可随时撤销。`;
		await message.send({ format: commandBubble(text, "智能程度与权益", {
			platform: event.Platform,
			actions: access.canEdit ? [...intelligenceLevels.map((label) => ({
				label,
				command: `/智能程度 ${label}`
			})), {
				label: "恢复默认",
				command: "/智能程度 默认"
			}] : [{
				label: "我的钥匙",
				command: "/我的钥匙"
			}]
		}) });
	} catch (error) {
		await message.send({ format: commandBubble(error instanceof Error ? error.message : "设置失败", "智能程度", { platform: event.Platform }) });
	}
};

export { res_default as default };