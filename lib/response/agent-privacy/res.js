import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-privacy/res.ts
const privacyText = [
	"# 数据与隐私",
	"",
	"## 数据使用",
	"- 收到的群聊和允许访问的私聊会保存为聊天记录，默认保留 30 天；附件只记录类型，主人验证码不保存。机器人只能查询当前会话的记录，不能跨群或读取别人的私聊。",
	"- 回答时，当前消息、相关聊天记录和记忆可能发送给已配置的模型服务。启用图片、音频或语音回复后，相关内容也会发送给对应服务。",
	"- 机器人会参考近期对话，并可能从聊天记录整理长期记忆。记忆可能有误，可用 `/记忆来源` 核对；私聊保存的偏好不会用于群聊。",
	"- 人格、心情和明确保存的记忆会保留到新话题中。平台操作也会留存记录；如使用第三方消息服务，相关消息和操作会交给该服务处理。",
	"- 实际保留期限和功能是否开启，以机器人主人的配置为准。",
	"",
	"## 查看与删除",
	"- `/聊天参考`：查看近期聊天参考。`/新会话`：开始新话题，清除短期对话；不删除聊天记录、长期记忆或人格设定。群内开始新话题需要管理员或主人权限。",
	"- `/清除聊天记录`：删除当前会话的聊天记录，需要再次确认；私聊本人可用，群聊仅主人可用。",
	"- `/记忆`、`/记忆检索`、`/记忆来源`：查看与核对记忆；`/忘记 编号` 或 `/忘记全部`：删除私聊记忆。群管理员或主人可用 `/忘记群记忆` 删除群记忆。",
	"- 聊天记录和记忆需要分别删除。仅清除其中一种，不会同时删除另一种。",
	"- `/清除群数据`：主人在目标群内发起彻底清理，需要再次确认；本群人格选择和心情也会清除，全局人格设定保留。",
	"",
	"请勿在聊天中发送密钥等敏感凭证。"
].join("\n");
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const [message] = useMessage();
	await message.send({ format: Format.create().addMarkdownOriginal(privacyText) });
};

export { res_default as default };