import { budgetAdjustments, budgetEnabled, budgetStatus, manageBudget, replyGateBudgetStatus } from "../../billing/budget.js";
import { getConversationId } from "../dsh/util.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { personalKeyStatus } from "../../credentials/personal.js";
import { groupKeyStatus } from "../../credentials/group.js";
import { toUserMessage } from "../../dsh/client.js";
import { commandBubble, sectionBubble } from "../bubble.js";
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
		command: "/我的钥匙 私聊"
	} : {
		label: "群密钥",
		command: "/我的钥匙"
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
	let actions = budgetActions(event);
	if (budgetEnabled(config)) try {
		const command = parseBudgetCommand(route.rawArgs.map(String), event);
		if (command.action === "help") {
			await message.send({ format: commandBubble(budgetHelp, "今日额度", {
				platform: event.Platform,
				layout: "keyboard",
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
			if (!rows.length) {
				await message.send({ format: commandBubble("今天没有手动额度调整记录。", "今日额度", {
					platform: event.Platform,
					layout: "keyboard",
					actions: budgetActions(event)
				}) });
				return;
			}
			const sections = rows.map((row) => ({
				title: `${(/* @__PURE__ */ new Date(row.at * 1e3)).toLocaleTimeString("zh-CN", {
					timeZone: "Asia/Shanghai",
					hour12: false
				})} · 主人 ${row.actor}`,
				text: `${row.operation === "add" ? "增加" : "设置"} ${(row.amount / 1e6).toFixed(2)} 元；${row.ledger === "paidLimit" ? rechargeLabel : freeLabel} ${(row.before / 1e6).toFixed(2)} → ${(row.after / 1e6).toFixed(2)} 元`,
				actions: []
			}));
			sections.push({
				title: "更多",
				text: "",
				actions: [{
					label: "刷新",
					command: "/额度"
				}, {
					label: "教程",
					command: "/帮助 额度"
				}]
			});
			await message.send({ format: sectionBubble("额度记录", "最近 5 次手动调整。", sections, {
				platform: event.Platform,
				layout: "inline"
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
		const sameTarget = command.scope.channelId === getConversationId(event);
		const target = sameTarget ? event.IsPrivate ? "本人私聊" : "本群" : command.scope.channelId;
		const keyName = groupKey ? "群密钥" : "个人密钥";
		const keyCommand = groupKey ? "/我的钥匙" : "/我的钥匙 私聊";
		const money = (amount) => amount > 0 && amount < .01 ? "<0.01" : amount.toFixed(2);
		const table = [
			"| 来源 | 已用 / 上限 | 可用 |",
			"| --- | --- | --- |",
			...gate ? [`| 群感知 | ${money(gate.freeUsed)} / ${money(gate.limit)} | ${money(gate.freeRemaining)} |`] : [],
			`| ${rechargeLabel} | ${money(value.paidUsed)} / ${money(value.paidLimit)} | ${money(value.paidRemaining)} |`,
			...isPrivate || sameTarget ? [`| 个人免费 | ${money(value.personalUsed)} / ${money(value.personalLimit)} | ${money(value.personalRemaining)} |`] : []
		];
		actions = [
			{
				label: "刷新",
				command: "/额度"
			},
			...event.IsMaster ? [{
				label: "记录",
				command: "/额度 记录"
			}] : [],
			...sameTarget ? [{
				label: keyName,
				command: keyCommand
			}] : []
		];
		const intro = [notice.trim(), `${target} · ${value.day}`].filter(Boolean).join("\n");
		const details = [
			`本次可用：${money(value.available)} 元${gate?.blocked ? "（感知预算不足）" : value.blocked ? "（不足）" : ""}`,
			groupKey?.enabled ? "群 Key 优先，不扣内部额度。" : personal?.enabled ? "个人 Key 优先，不扣额度。" : "",
			event.IsPrivate && event.IsMaster ? `全局今日已用 ${money(value.globalUsed)} 元${value.globalLimit > 0 ? ` / 上限 ${money(value.globalLimit)} 元` : "（未设上限）"}` : "",
			value.blocked && !groupKey?.enabled && !personal?.enabled ? isPrivate ? "额度不足：可绑定个人密钥或等免费额度北京时间零点重置；充值余额跨天保留。" : "额度不足：可增加群充值或绑定群密钥，也可等北京时间零点恢复免费额度。" : "",
			gate?.blocked && !groupKey?.enabled ? "感知不足：后台判断暂停，@我仍可使用。" : "",
			"免费额度北京时间零点重置；充值余额跨天保留。"
		].filter(Boolean);
		text = [
			intro,
			"",
			table.join("\n"),
			"",
			...details
		].join("\n");
	} catch (error) {
		text = toUserMessage(error);
	}
	await message.send({ format: commandBubble(text, "今日额度", {
		platform: event.Platform,
		layout: "auto",
		actions
	}) });
};

export { res_default as default };