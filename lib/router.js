import { contextEvents } from "./social/event-context.js";
import { Router } from "alemonjs";

// src/router.ts
const router = Router.create();
router.res({ events: [...contextEvents] }, () => import("./response/platform-events/res.js"));
router.res({ events: ["message.create", "private.message.create"] }, () => import("./response/personal-login/res.js"));
router.res({ events: ["message.create", "private.message.create"] }, () => import("./response/history-capture/res.js"));
const commandGroup = router.group({
	events: ["message.create", "private.message.create"],
	routeText: {
		prefixes: ["/"],
		stripPrefix: true,
		allowBare: false
	},
	fallback: { suggest: false },
	duplicateKey: "throw"
});
commandGroup.use({
	path: "关闭",
	description: "主人全局关闭 AI 请求并设置原因"
}, () => import("./response/ai-switch/res.js"));
commandGroup.use({
	path: "开启",
	description: "主人全局恢复 AI 请求"
}, () => import("./response/ai-switch/res.js"));
commandGroup.use({
	path: "主动搭话",
	events: ["private.message.create"],
	description: "主人管理自己的主动搭话订阅"
}, () => import("./response/agent-proactive/res.js"));
commandGroup.use({
	path: "额度",
	description: "查询今日额度；主人可手动增加、设置、查看调整记录"
}, () => import("./response/agent-budget/res.js"));
commandGroup.use({
	path: "人格",
	description: "查看及切换当前会话人格"
}, () => import("./response/agent-persona/res.js"));
commandGroup.use({
	path: "心情",
	description: "查看当前会话心情及变化"
}, () => import("./response/agent-mood/res.js"));
commandGroup.use({
	path: "清除聊天记录",
	description: "清除当前会话的持久化聊天归档"
}, () => import("./response/history-clear/res.js"));
commandGroup.use({
	path: "我是主人",
	events: ["private.message.create"],
	description: "申请主人验证码"
}, () => import("./response/master/res.js"));
commandGroup.use({
	path: "我的主人",
	events: ["private.message.create"],
	description: "验证并加入机器人主人"
}, () => import("./response/master/res.js"));
commandGroup.use({
	path: "agenthelp",
	description: "查看使用说明"
}, () => import("./response/agent-help/res.js"));
commandGroup.use({
	path: "agent",
	description: "查看 AgentLink 使用说明"
}, () => import("./response/agent-help/res.js"));
commandGroup.use({
	path: "agentpolicy",
	description: "主人管理当前群 Agent 工具策略"
}, () => import("./response/agent-policy/res.js"));
commandGroup.use({
	path: "agentmodules",
	events: ["private.message.create"],
	description: "主人查看模块加载状态并检查更新"
}, () => import("./response/agent-modules/res.js"));
commandGroup.use({
	path: "agentpurge",
	description: "主人清除当前群 Agent 数据"
}, () => import("./response/agent-purge/res.js"));
commandGroup.use({
	path: "agentmodels",
	events: ["private.message.create"],
	description: "主人私聊查看模型服务可用模型"
}, () => import("./response/agent-models/res.js"));
commandGroup.use({
	path: "cancel",
	events: ["message.create", "private.message.create"],
	description: "取消自己正在处理或排队的请求"
}, () => import("./response/agent-cancel/res.js"));
commandGroup.use({
	path: "agentmodel",
	events: ["private.message.create"],
	description: "主人私聊查看模型及配置修改指引"
}, () => import("./response/agent-model/res.js"));
commandGroup.use({
	path: "agentcontext",
	description: "预览下一次会提供给 DSH 的近期上下文"
}, () => import("./response/agent-context/res.js"));
commandGroup.use({
	path: "agentcontext clear",
	description: "清除当前群的近期普通聊天上下文"
}, () => import("./response/agent-context-clear/res.js"));
commandGroup.use({
	path: "agentprivacy",
	description: "查看聊天数据与隐私说明"
}, () => import("./response/agent-privacy/res.js"));
commandGroup.use({
	path: "agentbind",
	events: ["private.message.create"],
	description: "主人私聊查看模型 API Key 配置指引"
}, () => import("./response/agent-bind/res.js"));
commandGroup.use({
	path: "agentunbind",
	events: ["private.message.create"],
	description: "主人私聊查看模型 API Key 移除指引"
}, () => import("./response/agent-unbind/res.js"));
commandGroup.use({
	path: "agentstatus",
	description: "查看 DSH 自动安装和服务状态"
}, () => import("./response/agent-status/res.js"));
commandGroup.use({
	path: "new",
	description: "开始新的群会话"
}, () => import("./response/agent-new/res.js"));
commandGroup.use({
	path: "chat",
	description: "向 Agent 发送消息"
}, () => import("./response/agent-chat/res.js"));
commandGroup.use({
	path: "提问",
	description: "向 Agent 发送消息"
}, () => import("./response/agent-chat/res.js"));
commandGroup.use({
	path: "取消",
	description: "取消自己的请求"
}, () => import("./response/agent-cancel/res.js"));
commandGroup.use({
	path: "新会话",
	description: "开始新的会话"
}, () => import("./response/agent-new/res.js"));
commandGroup.use({
	path: "聊天参考",
	description: "查看近期聊天参考"
}, () => import("./response/agent-context/res.js"));
commandGroup.use({
	path: "工具策略",
	description: "主人管理当前群 Agent 工具策略"
}, () => import("./response/agent-policy/res.js"));
commandGroup.use({
	path: "群设置",
	description: "群管理员调整本群说话频率、免打扰、唤醒词与禁语"
}, () => import("./response/agent-group-settings/res.js"));
commandGroup.use({
	path: "状态",
	description: "查看服务状态"
}, () => import("./response/agent-status/res.js"));
commandGroup.use({
	path: "隐私说明",
	description: "查看聊天数据与隐私说明"
}, () => import("./response/agent-privacy/res.js"));
commandGroup.use({
	path: "帮助",
	description: "查看使用说明"
}, () => import("./response/agent-help/res.js"));
commandGroup.use({
	path: "模型列表",
	events: ["private.message.create"],
	description: "主人私聊查看可用模型"
}, () => import("./response/agent-models/res.js"));
commandGroup.use({
	path: "当前模型",
	events: ["private.message.create"],
	description: "主人私聊查看当前配置模型"
}, () => import("./response/agent-model/res.js"));
commandGroup.use({
	path: "模型池",
	events: ["private.message.create"],
	description: "主人私聊查看模型池、翻页，以及启用/停用/通测端点"
}, () => import("./response/agent-pool/res.js"));
commandGroup.use({
	path: "聊天参考 清除",
	description: "清除近期聊天参考"
}, () => import("./response/agent-context-clear/res.js"));
commandGroup.use({
	path: "清除群数据",
	description: "主人清除当前群 Agent 数据"
}, () => import("./response/agent-purge/res.js"));
commandGroup.use({
	path: "模块状态",
	events: ["private.message.create"],
	description: "主人查看模块状态"
}, () => import("./response/agent-modules/res.js"));
commandGroup.use({
	path: "密钥配置",
	events: ["private.message.create"],
	description: "主人查看密钥配置指引"
}, () => import("./response/agent-bind/res.js"));
commandGroup.use({
	path: "移除密钥",
	events: ["private.message.create"],
	description: "主人查看密钥移除指引"
}, () => import("./response/agent-unbind/res.js"));
commandGroup.use({
	path: "语音",
	description: "使用 AI 合成语音回答，不可用时回退文字"
}, () => import("./response/agent-voice/res.js"));
commandGroup.use({
	path: "语音引擎",
	events: ["private.message.create"],
	description: "主人检查、安装和试听语音引擎"
}, () => import("./response/agent-speech/res.js"));
commandGroup.use({
	path: "表情",
	description: "列出或发送配置的表情素材"
}, () => import("./response/agent-sticker/res.js"));
for (const path of [
	"记忆",
	"记住",
	"忘记",
	"忘记全部"
]) commandGroup.use({
	path,
	events: ["private.message.create"],
	description: "查看、保存或删除自己的长期记忆"
}, () => import("./response/agent-memory/res.js"));
for (const path of [
	"记忆检索",
	"记忆来源",
	"过时记忆",
	"恢复记忆",
	"整理记忆",
	"群记忆",
	"忘记群记忆"
]) commandGroup.use({
	path,
	events: ["message.create", "private.message.create"],
	description: "检索、核对和管理当前会话的长期记忆"
}, () => import("./response/memory-tools/res.js"));
for (const path of [
	"我的钥匙",
	"授权钥匙",
	"授权记录",
	"个人密钥",
	"apikey",
	"群密钥",
	"groupapikey"
]) commandGroup.use({
	path,
	description: "按用途管理钥匙和可撤销的群授权"
}, () => import("./response/keyring/res.js"));
router.res({ events: ["message.create"] }, () => import("./response/chat-context/capture.js"));
router.res({ events: ["message.create"] }, () => import("./response/dsh/res.js"));
router.res({ events: ["private.message.create"] }, () => import("./response/private-chat/res.js"));
var router_default = router.define;

export { router_default as default };