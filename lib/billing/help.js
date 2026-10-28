// src/billing/help.ts
const personalKeyGuide = [
	"添加个人密钥（仅用于本人私聊）：",
	"1. 准备一个有余额的 DeepSeek API Key。",
	"2. 私聊发送 /个人密钥 绑定 sk-你的Key，把 sk-你的Key 换成真实密钥。",
	"3. 绑定后重新提问；曾因欠费停用，充值后发 /个人密钥 启用。",
	"真实密钥只在私聊提交，不要发到群里。"
].join("\n");
const groupKeyGuide = [
	"添加群密钥（供本群使用）：",
	"1. 群主或管理员在本群发送 /群密钥 绑定。",
	"2. 拿到临时码后，由申请人私聊发送 /群密钥 绑定 临时码 sk-你的Key。",
	"把临时码和 sk-你的Key 换成实际值；临时码 5 分钟有效。",
	"真实密钥不要发到群里。"
].join("\n");
const quotaHelp = (isPrivate) => [
	"个人免费额度跨群和私聊共用，默认每天1元；群感知判断另算每天1元。",
	isPrivate ? personalKeyGuide : groupKeyGuide,
	"可联系机器人主人加额度，或等北京时间零点重置；/额度 查看剩余。"
].join("\n\n");
/** 额度不足提示上的可点入口，和正文教程里的指令一一对应。 */
const budgetNoticeActions = (isPrivate) => isPrivate ? [
	{
		label: "个人密钥",
		command: "/个人密钥"
	},
	{
		label: "绑定密钥",
		command: "/个人密钥 绑定"
	},
	{
		label: "启用密钥",
		command: "/个人密钥 启用"
	},
	{
		label: "查额度",
		command: "/额度"
	}
] : [{
	label: "申请密钥",
	command: "/群密钥 绑定"
}, {
	label: "查额度",
	command: "/额度"
}];
const insufficientBudgetHelp = (isPrivate) => [
	"本次可用额度不足。",
	isPrivate ? personalKeyGuide : groupKeyGuide,
	"可联系机器人主人加额度，或等北京时间零点重置；/额度 可查剩余。"
].join("\n\n");

export { budgetNoticeActions, groupKeyGuide, insufficientBudgetHelp, personalKeyGuide, quotaHelp };