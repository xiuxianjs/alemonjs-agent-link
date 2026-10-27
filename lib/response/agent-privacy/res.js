import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-privacy/res.ts
const privacyText = [
	"数据与隐私",
	"群聊和获准访问的私聊会保存聊天记录，默认保留30天，实际以配置为准。附件仅记录类型，不保存主人验证码。",
	"回答时，当前消息、相关记录和记忆可能发给模型服务；图片、音频也可能交给对应媒体服务。",
	"仅查询当前会话，群与私聊隔离；私聊偏好不用于群聊。记忆可能有误，/记忆来源 编号 可核对。",
	"平台操作会留存记录；使用第三方消息服务时，相关消息和操作由该服务处理。",
	"",
	"/新会话：清空短期对话，保留聊天记录、长期记忆、人格和心情；群内需管理员或主人。",
	"/清除聊天记录：永久删除当前会话归档，需确认；私聊本人或群内机器人主人可用。",
	"/忘记 编号、/忘记全部：删除私聊记忆；/忘记群记忆 编号或全部：管理员或主人删除群记忆。记录与记忆须分别删除。",
	"/清除群数据：主人在目标群彻底清理，需确认；全局人格保留。",
	"请勿发送公共密钥等敏感凭证。"
].join("\n");
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const [message] = useMessage();
	await message.send({ format: Format.create().addMarkdownOriginal(privacyText) });
};

export { res_default as default };