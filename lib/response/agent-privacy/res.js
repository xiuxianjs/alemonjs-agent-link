import { sectionBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-privacy/res.ts
const privacySections = [
	{
		title: "保存哪些内容",
		text: "群聊和获准访问的私聊会保存聊天记录，默认保留30天（以配置为准）。附件只记类型，不保存主人验证码。"
	},
	{
		title: "如何使用与保护",
		text: "当前消息、相关记录和记忆可能发给模型服务；图片、音频可能交给媒体服务。\n只查当前会话，群与私聊隔离，私聊偏好不用于群聊；记忆可能有误，用 /记忆来源 编号 核对。\n平台操作会留记录；第三方消息服务的消息与操作由其处理。"
	},
	{
		title: "查看与删除",
		text: "/新会话 清空对话，保留记录、记忆、人格、心情；群内需管理员或主人。\n/清除聊天记录 永久删除本会话归档，需确认；本人私聊或群主人可用。\n/忘记 编号、/忘记全部 删私聊记忆；/忘记群记忆 编号或全部 由管理员或主人删群记忆。记录与记忆须分别删除。\n/清除群数据 由主人在目标群彻底清理，需确认；全局人格保留。\n不要发送公共密钥等敏感凭证。",
		actions: [{
			label: "帮助",
			command: "/帮助 数据"
		}, {
			label: "清除记录",
			command: "/清除聊天记录"
		}]
	}
];
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	await message.send({ format: sectionBubble("大肥鱼 · 数据与隐私", "按钮只填入，确认后发送。", privacySections, { platform: event.Platform }) });
};

export { res_default as default };