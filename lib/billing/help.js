// src/billing/help.ts
const personalKeyGuide = [
	"添加个人密钥（仅用于本人私聊）：",
	"1. 准备一个有余额的 DeepSeek API Key。",
	"2. 私聊发送 /我的钥匙 私聊 添加 sk-你的Key，把 sk-你的Key 换成真实密钥。",
	"3. 绑定后重新提问；曾因欠费停用，充值后发 /我的钥匙 私聊 启用。",
	"真实密钥只在私聊提交，不要发到群里。"
].join("\n");
const groupKeyGuide = [
	"添加群密钥（供本群使用）：",
	"1. 私聊发送 /我的钥匙 群聊 添加 sk-你的Key。",
	"2. 管理员在目标群发送 /我的钥匙，点击 /授权钥匙 编号。",
	"3. 群管理员在 /我的钥匙 点击移除；提供者也可私聊 /授权记录 撤销。",
	"真实密钥不要发到群里。"
].join("\n");
const quotaHelp = (isPrivate) => [
	"个人免费额度跨群和私聊共用。",
	isPrivate ? personalKeyGuide : groupKeyGuide,
	"可联系机器人主人加额度，或等北京时间零点重置；/额度 查看剩余。"
].join("\n\n");
/** 额度不足提示上的可点入口，和正文教程里的指令一一对应。 */
const budgetNoticeActions = (isPrivate) => isPrivate ? [
	{
		label: "绑定密钥",
		command: "/我的钥匙 私聊 添加"
	},
	{
		label: "启用密钥",
		command: "/我的钥匙 私聊 启用"
	},
	{
		label: "查额度",
		command: "/额度"
	}
] : [{
	label: "申请密钥",
	command: "/我的钥匙"
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