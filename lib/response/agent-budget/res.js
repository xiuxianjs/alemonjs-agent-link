import { groupKeyGuide, insufficientBudgetHelp } from "../../billing/help.js";
import { budgetAdjustments, budgetEnabled, budgetStatus, manageBudget, replyGateBudgetStatus } from "../../billing/budget.js";
import { personalKeyStatus } from "../../credentials/personal.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { groupKeyStatus } from "../../credentials/group.js";
import { toUserMessage } from "../../dsh/client.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { budgetHelp, parseBudgetCommand } from "../../billing/commands.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-budget/res.ts
const budgetActions = (event) => [
	{
		label: "重新查询",
		command: "/额度"
	},
	...event.IsMaster ? [{
		label: "调整记录",
		command: "/额度 记录"
	}] : [],
	event.IsPrivate ? {
		label: "个人密钥",
		command: "/个人密钥"
	} : {
		label: "群密钥",
		command: "/群密钥 状态"
	},
	{
		label: "额度教程",
		command: "/帮助 额度"
	}
];
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const [route] = useRoute();
	const config = getDSHConfig();
	let text = "当前未设置每日额度。";
	if (budgetEnabled(config)) try {
		const command = parseBudgetCommand(route.rawArgs.map(String), event);
		if (command.action === "help") {
			await message.send({ format: commandBubble(budgetHelp, "今日额度", {
				platform: event.Platform,
				actions: budgetActions(event)
			}) });
			return;
		}
		const isPrivate = command.scope.channelId.startsWith("private:");
		const rechargeLabel = isPrivate ? "私聊充值" : "群充值";
		const freeLabel = isPrivate ? "个人免费总额度" : "群感知总预算";
		let notice = "";
		if (command.action === "add" || command.action === "set") {
			const adjusted = await manageBudget(config, command.scope, {
				isMaster: Boolean(event.IsMaster),
				platform: event.Platform || "",
				userId: event.UserId || "",
				channelId: getConversationId(event),
				messageId: event.MessageId || ""
			}, command.action, command.amount);
			notice = `调整结果（${adjusted.day}）：${command.action === "add" ? `${rechargeLabel}额度` : freeLabel} ${(adjusted.before / 1e6).toFixed(2)} → ${(adjusted.after / 1e6).toFixed(2)} 元。\n`;
		}
		if (command.action === "history") {
			const rows = await budgetAdjustments(command.scope, Boolean(event.IsMaster));
			await message.send({ format: commandBubble(rows.length ? rows.map((row) => `${(/* @__PURE__ */ new Date(row.at * 1e3)).toLocaleTimeString("zh-CN", {
				timeZone: "Asia/Shanghai",
				hour12: false
			})} 主人 ${row.actor}：${row.operation === "add" ? "增加" : "设置"} ${(row.amount / 1e6).toFixed(2)} 元，${row.ledger === "paidLimit" ? `${rechargeLabel}额度` : freeLabel} ${(row.before / 1e6).toFixed(2)} → ${(row.after / 1e6).toFixed(2)} 元`).join("\n") : "今天没有手动额度调整记录。", "今日额度", {
				platform: event.Platform,
				actions: budgetActions(event)
			}) });
			return;
		}
		const value = await budgetStatus(config, {
			...command.scope,
			...command.scope.channelId === getConversationId(event) ? { userId: event.UserId } : {}
		});
		const gate = command.scope.channelId.startsWith("private:") ? void 0 : await replyGateBudgetStatus(config, command.scope);
		const personal = event.IsPrivate && command.scope.channelId === getConversationId(event) ? await personalKeyStatus({
			...command.scope,
			userId: event.UserId
		}) : void 0;
		const groupKey = !command.scope.channelId.startsWith("private:") ? await groupKeyStatus(command.scope) : void 0;
		const target = command.scope.channelId === getConversationId(event) ? event.IsPrivate ? "本人私聊" : "本群" : command.scope.channelId;
		text = [
			notice,
			`${target} · ${value.day}`,
			groupKey?.enabled ? "付费顺序：群 Key → 群充值 → 个人免费；感知判断另计。" : "",
			personal ? `当前模式：${personal.enabled ? "个人 Key 优先（不扣额度）" : "额度模式"}；/个人密钥 查看。` : "",
			gate ? `群感知：免费已用 ${gate.freeUsed.toFixed(4)} / ${gate.limit.toFixed(2)} 元，剩余 ${gate.freeRemaining.toFixed(4)} 元` : "",
			`${rechargeLabel}：已用 ${value.paidUsed.toFixed(4)} / ${value.paidLimit.toFixed(2)} 元，剩余 ${value.paidRemaining.toFixed(4)} 元（优先使用，不扣免费）`,
			isPrivate || command.scope.channelId === getConversationId(event) ? `个人免费（跨群和私聊共享）：已用 ${value.personalUsed.toFixed(4)} / ${value.personalLimit.toFixed(2)} 元，剩余 ${value.personalRemaining.toFixed(4)} 元\n聊天本次可用：${value.available.toFixed(4)} 元` : "",
			"北京时间零点重置；群聊没有共享免费额度。",
			value.blocked && !groupKey?.enabled && !personal?.enabled ? `\n${insufficientBudgetHelp(isPrivate)}` : gate?.blocked && !groupKey?.enabled ? `\n后台感知预算不足，明确呼唤仍可使用。\n${groupKeyGuide}` : "",
			event.IsPrivate && event.IsMaster ? `全局今日已用：${value.globalUsed.toFixed(4)} 元。` : ""
		].filter(Boolean).join("\n");
	} catch (error) {
		text = toUserMessage(error);
	}
	await message.send({ format: commandBubble(text, "今日额度", {
		platform: event.Platform,
		actions: budgetActions(event)
	}) });
};

export { res_default as default };