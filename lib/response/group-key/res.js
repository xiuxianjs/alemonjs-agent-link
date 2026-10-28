import { DSHError } from "../../dsh/errors.js";
import { groupKeyGuide } from "../../billing/help.js";
import { getGroupChatPolicy } from "../../social/group-policy.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { groupKeyStatus, issueGroupKeyCode, redeemGroupKeyCode } from "../../credentials/group.js";
import "../../dsh/client.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/group-key/res.ts
const actions = {
	绑定: "bind",
	启用: "enable",
	开启: "enable",
	停用: "disable",
	关闭: "disable",
	移除: "remove"
};
const labels = {
	bind: "绑定",
	enable: "启用",
	disable: "停用",
	remove: "移除"
};
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const [message] = useMessage();
	const [route] = useRoute();
	const args = route.rawArgs.map(String);
	let text;
	try {
		if (!event.IsPrivate) {
			const isAdmin = await verifyGroupKeyAdmin(event);
			if (!isAdmin) throw new DSHError("budget", "平台未确认你是本群管理员，无法管理群 Key。请确认管理员身份或成员查询权限。");
			if (args.length === 0 || args.length === 1 && args[0] === "状态") {
				const status = await groupKeyStatus({
					platform: event.Platform || "",
					channelId: event.ChannelId || ""
				});
				const elevated = status.enabled && getGroupChatPolicy(getDSHConfig().groupChat, event.ChannelId || "").boundKeyElevation !== false;
				const rights = !status.bound ? "" : elevated ? "\n\n自带 Key 权益：参与强度已拉满（不经过感知判断、冷却 0 秒、每小时最多 60 次），网页与文件工具自动开放；终端始终禁止，夜间静默仍按 groupChat 配置。" : "\n\n自带 Key 权益：本群已按配置关闭（boundKeyElevation: false），按普通群策略运行。";
				text = `本群密钥：${!status.bound ? "未绑定" : status.enabled ? "已启用" : status.reason === "balance" ? "余额不足，已自动停用" : "已停用"}。${rights}\n\n${groupKeyGuide}\n\n已有密钥充值后，在群里发送 /群密钥 启用 申请新的临时码，再按提示私聊确认。\n停用或移除时，在群里发送 /群密钥 停用 或 /群密钥 移除。`;
			} else {
				const action = actions[args[0]];
				if (!action || args.length !== 1) throw new DSHError("budget", groupKeyGuide);
				const proof = await issueGroupKeyCode({
					platform: event.Platform || "",
					channelId: event.ChannelId || "",
					userId: event.UserId || "",
					isPrivate: false,
					isAdmin,
					messageId: event.MessageId || ""
				}, action);
				text = `群 Key ${labels[action]}临时码：${proof.code}\n5 分钟有效，仅申请人本人可用，提交一次即失效。\n请本人私聊机器人发送：/群密钥 ${labels[action]} ${proof.code}${action === "bind" ? " sk-你的Key" : ""}\n重新申请会使本人在本群的旧码失效。`;
			}
		} else {
			const shorthand = /^[a-f0-9]{24}$/iu.test(args[0] || "");
			const action = shorthand ? "bind" : actions[args[0]];
			const code = args[shorthand ? 0 : 1];
			const apiKey = action === "bind" ? args[shorthand ? 1 : 2] : void 0;
			const expected = shorthand ? 2 : action === "bind" ? 3 : 2;
			if (!action || args.length !== expected) throw new DSHError("budget", groupKeyGuide);
			const result = await redeemGroupKeyCode({
				platform: event.Platform || "",
				userId: event.UserId || "",
				channelId: getConversationId(event)
			}, code, action, apiKey);
			text = result.duplicate ? "该临时码已处理，不会重复操作。" : `群 ${result.channelId} 的 Key 已${labels[action]}。${action === "bind" || action === "enable" ? "本群聊天和主动识别优先使用，余额不足时停用并转为群额度模式。" : "后续使用群额度模式。"}`;
		}
	} catch (error) {
		text = error instanceof DSHError ? error.message : "群 Key 操作失败，请重新申请临时码；仍失败请联系主人。";
	}
	await message.send({ format: commandBubble(text, "群密钥", {
		platform: event.Platform,
		actions: [
			{
				label: "群密钥状态",
				command: "/群密钥 状态"
			},
			{
				label: "启用密钥",
				command: "/群密钥 启用"
			},
			{
				label: "停用密钥",
				command: "/群密钥 停用"
			},
			{
				label: "额度教程",
				command: "/帮助 额度"
			}
		]
	}) });
};

export { res_default as default };