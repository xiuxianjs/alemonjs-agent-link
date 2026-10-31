import { getDSHConfig } from "../../dsh/runtime-config.js";
import { intelligenceLevels, readIntelligenceLevel, resolveIntelligenceAccess, saveIntelligenceLevel } from "../../agent/intelligence.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-intelligence/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const value = route.rawArgs.map(String).join(" ").trim();
	const queryOnly = route.key === "我的权限";
	if (queryOnly && value || !queryOnly && value && ![
		"状态",
		"默认",
		...intelligenceLevels
	].includes(value)) {
		await message.send({ format: commandBubble(queryOnly ? "查看权限不需要附加内容，也不会改变设置。要调整智能程度，请进入对应设置。" : "没有识别出这个档位。请打开智能程度设置，再选择适合的档位。", "智能程度与权限", {
			platform: event.Platform,
			actions: [{
				label: "查看权限",
				command: "/我的权限"
			}, {
				label: "智能程度设置",
				command: "/智能程度"
			}]
		}) });
		return;
	}
	try {
		const identity = {
			platform: event.Platform || "",
			channelId: getConversationId(event),
			userId: event.UserId || "",
			owner: Boolean(event.IsMaster),
			private: Boolean(event.IsPrivate),
			admin: !event.IsPrivate && await verifyGroupKeyAdmin(event)
		};
		if (!identity.platform || !identity.channelId || !identity.userId) throw new Error("identity unavailable");
		const config = getDSHConfig();
		if (!queryOnly && value && value !== "状态") await saveIntelligenceLevel(config, identity, value);
		const access = await resolveIntelligenceAccess(identity, config);
		const level = readIntelligenceLevel(config, identity, access.entitled) || access.defaultLevel;
		const role = identity.owner ? "机器人主人" : identity.admin ? "群管理员" : access.bound && identity.private ? "密钥主人" : "普通用户";
		const editable = access.canEdit;
		if (route.key !== "我的权限" && value && value !== "状态") {
			await message.send({ format: commandBubble(`范围：${identity.private ? "本人私聊" : "当前群聊"}\n${value === "默认" ? "已恢复自动选择" : "已保存智能程度"}：${level}\n下一轮对话生效，仍受服务上限约束。`, "智能程度已更新", {
				platform: event.Platform,
				actions: [
					{
						label: "查看权限",
						command: "/我的权限"
					},
					{
						label: "查看人设",
						command: "/人设"
					},
					...value !== "默认" ? [{
						label: "恢复默认",
						command: "/智能程度 默认"
					}] : []
				]
			}) });
			return;
		}
		await message.send({ format: sectionBubble("我的权限", `${role} · ${identity.private ? "本人私聊" : "当前群聊"}`, [
			{
				title: `智能程度 · ${level}`,
				text: editable ? "轻快：少量步骤；标准：常规任务；深度：更多步骤与续写；专研：更长的多步任务。\n档位越高，可能耗时和消耗越多；实际执行仍受服务上限约束。" : "当前使用会话默认设置。本人私聊绑定 Key 后可调整；群内需启用 Key 权益并由管理员操作。",
				actions: editable ? [...intelligenceLevels.filter((label) => label !== level).map((label) => ({
					label,
					command: `/智能程度 ${label}`
				})), {
					label: "默认",
					command: "/智能程度 默认"
				}] : []
			},
			{
				title: "专属人设",
				text: editable ? "可调整本会话的称呼、表达和人物细节。" : "本人绑定 Key 可编辑私聊人设；群内需 Key 权益与管理员身份。",
				actions: [{
					label: "查看人设",
					command: "/人设"
				}, ...editable ? [{
					label: "切换人格",
					command: "/人格"
				}] : []]
			},
			{
				title: "钥匙与额度",
				text: access.bound ? access.entitled ? "当前会话 Key 权益已启用。" : "已有可用 Key，群专属权益未启用。" : "当前会话未检测到可用绑定 Key。",
				actions: [{
					label: "额度",
					command: "/额度"
				}, ...identity.private || identity.admin ? [{
					label: "我的钥匙",
					command: "/我的钥匙"
				}] : []]
			},
			{
				title: "管理范围",
				text: identity.owner ? "全局管理；终端仅限主人私聊主动任务。" : identity.admin ? "管理本群；不能修改他人的钥匙和授权上限。" : identity.private && access.bound ? "管理自己的钥匙、授权和私聊设置。" : "使用基础服务，可私聊绑定自己的 Key。",
				actions: [...!identity.private && (identity.owner || identity.admin) ? [{
					label: "群设置",
					command: "/群设置"
				}] : [], ...identity.private && identity.owner ? [{
					label: "管理说明",
					command: "/帮助 管理"
				}, {
					label: "用量",
					command: "/用量"
				}] : []]
			}
		], {
			platform: event.Platform,
			actions: [{
				label: "刷新",
				command: "/我的权限"
			}, {
				label: "帮助",
				command: "/帮助"
			}]
		}) });
	} catch (error) {
		await message.send({ format: commandBubble(error instanceof Error && error.message === "本人绑定 Key 后可设置；群内需本群绑定 Key 且由管理员设置。" ? error.message : "查询或设置暂时无法确认完成。请先查看权限，核对当前档位后再决定是否重试。", "智能程度", {
			platform: event.Platform,
			actions: [{
				label: "查看权限",
				command: "/我的权限"
			}]
		}) });
	}
};

export { res_default as default };