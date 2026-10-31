import { canManageConversation } from "../dsh/util.js";
import { sectionBubble, supportsBubbles } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-privacy/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const [message] = useMessage();
	let canReset = Boolean(event.IsPrivate || event.IsMaster);
	if (!canReset) try {
		canReset = await canManageConversation(event);
	} catch {
		canReset = false;
	}
	const sections = [
		{
			title: "保存与使用",
			text: "聊天记录默认保留30天（以配置为准）；附件只记类型，不保存主人验证码。当前消息、相关记录和记忆可能发给模型服务；图片、音频可能交给媒体服务。平台操作会留记录。"
		},
		{
			title: "查看记忆",
			text: "群与私聊隔离，私聊偏好不用于群聊。记忆可能有误，可从条目查看全文与来源。",
			actions: [{
				label: event.IsPrivate ? "我的记忆" : "本群记忆",
				command: event.IsPrivate ? "/记忆" : "/群记忆"
			}]
		},
		{
			title: "换话题或删除",
			text: "新会话保留记录与长期记忆。记录和记忆须分别删除；删除归档需确认，群归档仅主人可删。",
			actions: [
				...canReset ? [{
					label: "开始新话题",
					command: "/新会话"
				}] : [],
				...event.IsPrivate || event.IsMaster ? [{
					label: "查看归档清除范围",
					command: "/清除聊天记录"
				}] : [],
				{
					label: "数据操作说明",
					command: "/帮助 数据"
				}
			]
		},
		{
			title: "清理群数据",
			text: "主人可在目标群发起清理，需确认；影响本服务中相同群编号的其他平台或机器人身份。具体删除与保留范围以确认页为准。请勿发送敏感凭证。",
			actions: !event.IsPrivate && event.IsMaster ? [{
				label: "查看群清理范围",
				command: "/清除群数据"
			}] : []
		}
	];
	await message.send({ format: sectionBubble("大肥鱼 · 数据与隐私", `${event.IsPrivate ? "当前：本人私聊" : "当前：本群"}\n${supportsBubbles(event.Platform) ? "点击入口填入指令，再发送。" : "复制对应指令发送。"}`, sections, { platform: event.Platform }) });
};

export { res_default as default };