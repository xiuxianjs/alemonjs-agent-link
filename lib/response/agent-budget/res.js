import { budgetAdjustments, budgetEnabled, budgetStatus, manageBudget } from "../../billing/budget.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
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
		let notice = "";
		if (command.action === "add" || command.action === "set") {
			const adjusted = await manageBudget(config, command.scope, {
				isMaster: Boolean(event.IsMaster),
				platform: event.Platform || "",
				userId: event.UserId || "",
				channelId: getConversationId(event),
				messageId: event.MessageId || ""
			}, command.action, command.amount);
			notice = `调整结果（${adjusted.day}）：今日总额度 ${(adjusted.before / 1e6).toFixed(2)} → ${(adjusted.after / 1e6).toFixed(2)} 元。\n`;
		}
		if (command.action === "history") {
			const rows = await budgetAdjustments(command.scope, Boolean(event.IsMaster));
			await message.send({ format: Format.create().addText(rows.length ? rows.map((row) => `${(/* @__PURE__ */ new Date(row.at * 1e3)).toLocaleTimeString("zh-CN", {
				timeZone: "Asia/Shanghai",
				hour12: false
			})} 主人 ${row.actor}：${row.operation === "add" ? "增加" : "设置"} ${(row.amount / 1e6).toFixed(2)} 元，总额 ${(row.before / 1e6).toFixed(2)} → ${(row.after / 1e6).toFixed(2)} 元`).join("\n") : "今天没有手动额度调整记录。") });
			return;
		}
		const value = await budgetStatus(config, command.scope);
		const target = command.scope.channelId === getConversationId(event) ? event.IsPrivate ? "本人私聊" : "本群共享" : command.scope.channelId;
		text = [
			notice,
			`目标：${target}\n今日总额度：${value.limit.toFixed(2)} 元`,
			`今日剩余：${value.remaining.toFixed(4)} 元`,
			`统计日期：${value.day}，北京时间零点恢复每日 ${value.defaultLimit.toFixed(2)} 元。`,
			event.IsPrivate && event.IsMaster ? `全局今日已用：${value.globalUsed.toFixed(4)} 元。` : ""
		].filter(Boolean).join("\n");
	} catch (error) {
		text = toUserMessage(error);
	}
	await message.send({ format: Format.create().addText(text) });
};

export { res_default as default };