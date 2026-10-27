import { budgetAdjustments, budgetEnabled, budgetStatus, manageBudget, replyGateBudgetStatus } from "../../billing/budget.js";
import { personalKeyStatus } from "../../credentials/personal.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { groupKeyStatus } from "../../credentials/group.js";
import { toUserMessage } from "../../dsh/client.js";
import { getConversationId } from "../dsh/util.js";
import { budgetHelp, parseBudgetCommand } from "../../billing/commands.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-budget/res.ts
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
			await message.send({ format: Format.create().addText(budgetHelp) });
			return;
		}
		const rechargeLabel = command.scope.channelId.startsWith("private:") ? "私聊充值" : "群充值";
		let notice = "";
		if (command.action === "add" || command.action === "set") {
			const adjusted = await manageBudget(config, command.scope, {
				isMaster: Boolean(event.IsMaster),
				platform: event.Platform || "",
				userId: event.UserId || "",
				channelId: getConversationId(event),
				messageId: event.MessageId || ""
			}, command.action, command.amount);
			notice = `调整结果（${adjusted.day}）：${command.action === "add" ? `${rechargeLabel}额度` : "免费总额度"} ${(adjusted.before / 1e6).toFixed(2)} → ${(adjusted.after / 1e6).toFixed(2)} 元。\n`;
		}
		if (command.action === "history") {
			const rows = await budgetAdjustments(command.scope, Boolean(event.IsMaster));
			await message.send({ format: Format.create().addText(rows.length ? rows.map((row) => `${(/* @__PURE__ */ new Date(row.at * 1e3)).toLocaleTimeString("zh-CN", {
				timeZone: "Asia/Shanghai",
				hour12: false
			})} 主人 ${row.actor}：${row.operation === "add" ? "增加" : "设置"} ${(row.amount / 1e6).toFixed(2)} 元，${row.ledger === "paidLimit" ? `${rechargeLabel}额度` : "免费总额度"} ${(row.before / 1e6).toFixed(2)} → ${(row.after / 1e6).toFixed(2)} 元`).join("\n") : "今天没有手动额度调整记录。") });
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
		const target = command.scope.channelId === getConversationId(event) ? event.IsPrivate ? "本人私聊" : "本群共享" : command.scope.channelId;
		text = [
			notice,
			groupKey?.enabled ? "当前模式：本群 Key 优先（不扣以下额度）；群管理员可用 /群密钥 管理。" : "",
			personal ? `当前模式：${personal.enabled ? "个人 Key 优先（不扣以下额度）" : "额度模式"}；/个人密钥 查看绑定状态。` : "",
			gate ? `回复判断：已用 ${gate.freeUsed.toFixed(4)} / ${gate.limit.toFixed(2)} 元，剩余 ${gate.freeRemaining.toFixed(4)}；另用群充值 ${gate.paidUsed.toFixed(4)} 元` : "",
			`${target} · ${value.day}\n会话总额：${value.limit.toFixed(2)} 元`,
			`会话免费：已用 ${value.freeUsed.toFixed(4)} / ${value.freeLimit.toFixed(2)} 元，剩余 ${value.freeRemaining.toFixed(4)} 元`,
			`${rechargeLabel}：已用 ${value.paidUsed.toFixed(4)} / ${value.paidLimit.toFixed(2)} 元，剩余 ${value.paidRemaining.toFixed(4)} 元（不扣个人免费）`,
			command.scope.channelId === getConversationId(event) ? `个人免费（跨群和私聊共享）：已用 ${value.personalUsed.toFixed(4)} / ${value.personalLimit.toFixed(2)} 元，剩余 ${value.personalRemaining.toFixed(4)} 元\n本次可用：${value.available.toFixed(4)} 元` : "",
			`北京时间零点重置，每日默认 ${value.defaultLimit.toFixed(2)} 元。`,
			event.IsPrivate && event.IsMaster ? `全局今日已用：${value.globalUsed.toFixed(4)} 元。` : ""
		].filter(Boolean).join("\n");
	} catch (error) {
		text = toUserMessage(error);
	}
	await message.send({ format: Format.create().addText(text) });
};

export { res_default as default };