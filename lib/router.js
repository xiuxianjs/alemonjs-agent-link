import { Router } from "alemonjs";

//#region src/router.ts
const router = Router.create({ events: ["message.create", "private.message.create"] });
const commandGroup = router.group({
	events: ["message.create", "private.message.create"],
	routeText: {
		prefixes: ["/"],
		stripPrefix: true,
		allowBare: false
	},
	fallback: {
		suggest: true,
		allowPrefixMatch: true
	},
	duplicateKey: "throw"
});
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
	events: ["message.create"],
	description: "取消自己正在处理或排队的请求"
}, () => import("./response/agent-cancel/res.js"));
commandGroup.use({
	path: "agentmodel",
	events: ["private.message.create"],
	description: "主人私聊查看或切换全局模型"
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
	description: "主人私聊绑定全群共用的模型 API Key"
}, () => import("./response/agent-bind/res.js"));
commandGroup.use({
	path: "agentunbind",
	events: ["private.message.create"],
	description: "主人私聊移除全群共用的模型 API Key"
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
router.res({ events: ["message.create"] }, () => import("./response/chat-context/capture.js"));
router.res({ events: ["message.create"] }, () => import("./response/dsh/res.js"));
var router_default = router.define;

//#endregion
export { router_default as default };