import { personalKeyGuide } from "../../billing/help.js";
import { bindPersonalKey, claimPersonalKeyCommand, personalKeyStatus, updatePersonalKey } from "../../credentials/personal.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/personal-key/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const [message] = useMessage();
	const [route] = useRoute();
	let text;
	if (!event.IsPrivate || !event.Platform || !event.UserId) text = "请在本人私聊管理 Key。若误发到群，请撤回并在服务商后台更换。";
	else {
		const scope = {
			platform: event.Platform,
			userId: event.UserId,
			channelId: getConversationId(event)
		};
		const args = route.rawArgs.map(String);
		try {
			if ([
				"绑定",
				"启用",
				"停用",
				"移除"
			].includes(args[0]) && !await claimPersonalKeyCommand(scope, event.MessageId || "")) {
				await message.send({ format: commandBubble("这条指令已处理，请勿重复提交。", "个人密钥", {
					platform: event.Platform,
					actions: [{
						label: "密钥状态",
						command: "/个人密钥 状态"
					}]
				}) });
				return;
			}
			if (args[0] === "绑定" && args.length === 2) {
				await bindPersonalKey(scope, args[1]);
				text = "个人 Key 已绑定并启用，仅用于本人私聊。余额不足会停用并改用额度；充值后需手动启用。";
			} else if (args.length === 1 && [
				"启用",
				"停用",
				"移除"
			].includes(args[0])) text = await updatePersonalKey(scope, {
				启用: "enable",
				停用: "disable",
				移除: "remove"
			}[args[0]]) ? `个人 Key 已${args[0]}。${args[0] === "启用" ? "下一次请求会检查余额并优先使用。" : "后续请求使用额度模式。"}` : "尚未绑定个人 Key。";
			else if (!args.length || args.length === 1 && args[0] === "状态") {
				const status = await personalKeyStatus(scope);
				text = `个人密钥：${!status.bound ? "未绑定" : status.enabled ? "已启用，私聊优先使用" : status.reason === "balance" ? "余额不足，充值后请发送 /个人密钥 启用" : "已停用"}。\n\n${personalKeyGuide}\n\n暂停使用：/个人密钥 停用\n删除绑定：/个人密钥 移除`;
			} else text = personalKeyGuide;
		} catch {
			text = "个人 Key 操作失败，请检查格式；仍失败请联系主人。";
		}
	}
	await message.send({ format: commandBubble(text, "个人密钥", {
		platform: event.Platform,
		actions: [
			{
				label: "密钥状态",
				command: "/个人密钥 状态"
			},
			{
				label: "额度",
				command: "/额度"
			},
			{
				label: "额度教程",
				command: "/帮助 额度"
			}
		]
	}) });
};

export { res_default as default };