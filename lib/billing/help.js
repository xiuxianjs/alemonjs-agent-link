// src/billing/help.ts
const personalKeyGuide = [
	"使用自己的 Key：",
	"私聊直接发送真实 Key，识别后点击「添加到私聊」。不用填写指令，也不用保留示例文字。",
	"用于本人私聊及本人触发的群回复，不分享给其他人。",
	"已有钥匙可在 /我的钥匙 私聊 查看；充值后用 /我的钥匙 私聊 启用。真实 Key 不要发到群里。"
].join("\n");
const groupKeyGuide = [
	"为群聊提供 Key：",
	"先私聊发送真实 Key，识别后点击「添加到群聊」。这一步只存入自己的钥匙库。",
	"再由提供者在目标群打开 /我的钥匙，选择要授权的钥匙；需要本群管理员身份。",
	"自己的分享可在私聊 /授权记录 撤销；真实 Key 不要发到群里。"
].join("\n");
const quotaHelp = (isPrivate) => [
	"个人免费额度跨群和私聊共用。",
	isPrivate ? personalKeyGuide : groupKeyGuide,
	"可联系机器人主人加额度，或等北京时间零点重置；/额度 查看剩余。"
].join("\n\n");
/** 额度不足提示上的可点入口，和正文教程里的指令一一对应。 */
const budgetNoticeActions = (isPrivate) => isPrivate ? [
	{
		label: "我的钥匙",
		command: "/我的钥匙 私聊"
	},
	{
		label: "启用密钥",
		command: "/我的钥匙 私聊 启用"
	},
	{
		label: "查额度",
		command: "/额度"
	},
	{
		label: "今日免扰",
		command: "/额度 今日不再提醒"
	}
] : [
	{
		label: "申请密钥",
		command: "/我的钥匙"
	},
	{
		label: "查额度",
		command: "/额度"
	},
	{
		label: "今日免扰",
		command: "/额度 今日不再提醒"
	}
];
const insufficientBudgetHelp = (isPrivate) => [
	"本次可用额度不足。自动额度提醒每天最多一次；/额度 今日不再提醒 可设置今日免扰。",
	isPrivate ? personalKeyGuide : groupKeyGuide,
	"可联系机器人主人加额度，或等北京时间零点重置；/额度 可查剩余。"
].join("\n\n");

export { budgetNoticeActions, groupKeyGuide, insufficientBudgetHelp, personalKeyGuide, quotaHelp };