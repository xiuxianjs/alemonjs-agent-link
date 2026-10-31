import { getDSHConfig } from "../../dsh/runtime-config.js";
import { budgetAdjustments, budgetEnabled, budgetStatus, manageBudget, muteBudgetNoticesToday, replyGateBudgetStatus } from "../../billing/budget.js";
import { getSponsors } from "../../sponsors/config.js";
import { getAds } from "../../ads/config.js";
import { personalKeyStatus } from "../../credentials/personal.js";
import { groupKeyStatus } from "../../credentials/group.js";
import { toUserMessage } from "../../dsh/client.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { getConversationId } from "../dsh/util.js";
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
	if (!route.matched) return;
	let config;
	try {
		config = getDSHConfig();
	} catch {
		await message.send({ format: commandBubble("额度配置暂不可用，请联系机器人主人核对服务配置。当前查询未能完成。", "今日额度", {
			platform: event.Platform,
			actions: [{
				label: "服务状态",
				command: "/状态"
			}, {
				label: "额度说明",
				command: "/帮助 额度"
			}]
		}) });
		return;
	}
	let text = "当前未设置每日额度。";
	let actions = budgetActions(event);
	let sources;
	if (route.rawArgs.map(String).join(" ").trim() === "帮助") {
		await message.send({ format: sectionBubble("额度怎么用", `${event.IsPrivate ? "本人私聊" : "当前群聊"} · ${budgetEnabled(config) ? "每日额度保护已开启" : "当前未开启每日额度保护"}`, [
			{
				title: "查看与免扰",
				text: "免费额度北京时间零点重置，充值余额跨天保留。群内今日免扰需管理员或主人。",
				actions: [{
					label: "查看额度",
					command: "/额度"
				}, {
					label: "今日免扰",
					command: "/额度 今日不再提醒"
				}]
			},
			{
				title: "使用自己的钥匙",
				text: "个人免费额度跨群和私聊共享；群与私聊充值分别使用。自带 Key 的用法见额度说明。",
				actions: [{
					label: "额度说明",
					command: "/帮助 额度"
				}]
			},
			...event.IsMaster ? [{
				title: "手动调整",
				text: `增加：填写元数，如 /额度 增加 2。
设置：私聊设置本人今日免费总额度；群内设置本群今日感知预算。不会重置已用量，也不涉及实际付款。
跨会话调整请指定目标，例如 /额度 查询 群 群ID。`,
				actions: [
					{
						label: "填写增加金额",
						command: "/额度 增加 "
					},
					{
						label: "填写设置金额",
						command: "/额度 设置 "
					},
					{
						label: "调整记录",
						command: "/额度 记录"
					}
				]
			}] : []
		], { platform: event.Platform }) });
		return;
	}
	if (route.rawArgs.map(String).join(" ").trim() === "今日不再提醒") {
		let notice;
		try {
			if (!event.IsPrivate && !event.IsMaster && !await verifyGroupKeyAdmin(event)) notice = "群内今日免扰需要群管理员或机器人主人设置。";
			else {
				await muteBudgetNoticesToday({
					platform: event.Platform || "",
					channelId: getConversationId(event)
				});
				notice = `${event.IsPrivate ? "本私聊" : "本群"}今日不再自动提醒聊天额度和感知预算不足，北京时间零点恢复。仍可发送 /额度 主动查询。`;
			}
		} catch {
			notice = "设置未成功，请稍后重试。";
		}
		await message.send({ format: commandBubble(notice, "额度提醒", {
			platform: event.Platform,
			actions: [{
				label: "查看额度",
				command: "/额度"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	if (budgetEnabled(config)) {
		let adjustmentReceipt = "";
		let targetDescription = "";
		try {
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
			const sameScope = command.scope.channelId === getConversationId(event);
			const targetSuffix = sameScope ? "" : isPrivate ? ` 私聊 ${JSON.parse(command.scope.channelId.slice(8))[1]}` : ` 群 ${command.scope.channelId}`;
			const queryCommand = `/额度${targetSuffix ? " 查询" + targetSuffix : ""}`;
			const historyCommand = `/额度 记录${targetSuffix}`;
			targetDescription = sameScope ? event.IsPrivate ? "本人私聊" : "本群" : targetSuffix.trim();
			actions = [
				{
					label: "查询目标额度",
					command: queryCommand
				},
				...event.IsMaster ? [{
					label: "目标调整记录",
					command: historyCommand
				}] : [],
				{
					label: "操作帮助",
					command: "/额度 帮助"
				}
			];
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
			adjustmentReceipt = notice.trim();
			if (command.action === "history") {
				const rows = await budgetAdjustments(command.scope, Boolean(event.IsMaster));
				if (!rows.length) {
					await message.send({ format: commandBubble(`${targetDescription}：今天没有手动额度调整记录。`, "今日额度", {
						platform: event.Platform,
						layout: "keyboard",
						actions
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
				await message.send({ format: sectionBubble("额度记录", `${targetDescription} · 最近 5 次手动调整。`, sections, {
					platform: event.Platform,
					actions: [
						{
							label: "刷新记录",
							command: `/额度 ${route.rawArgs.map(String).join(" ")}`
						},
						{
							label: "目标额度",
							command: queryCommand
						},
						{
							label: "教程",
							command: "/帮助 额度"
						}
					]
				}) });
				return;
			}
			const value = await budgetStatus(config, {
				...command.scope,
				...command.scope.channelId === getConversationId(event) ? { userId: event.UserId } : {}
			});
			const gate = command.scope.channelId.startsWith("private:") ? void 0 : await replyGateBudgetStatus(config, command.scope);
			const personal = command.scope.channelId === getConversationId(event) && event.UserId ? await personalKeyStatus({
				...command.scope,
				userId: event.UserId,
				channelId: `private:${JSON.stringify([event.Platform, event.UserId])}`
			}) : void 0;
			const groupKey = !command.scope.channelId.startsWith("private:") ? await groupKeyStatus(command.scope) : void 0;
			const sameTarget = command.scope.channelId === getConversationId(event);
			const target = targetDescription;
			const keyName = groupKey ? "群密钥" : "个人密钥";
			const keyCommand = groupKey ? "/我的钥匙" : "/我的钥匙 私聊";
			const money = (amount) => amount > 0 && amount < .01 ? "<0.01" : amount.toFixed(2);
			const sourceText = (used, limit, remaining) => `已用 ${money(used)} / 上限 ${money(limit)} 元；可用 ${money(remaining)} 元`;
			sources = [
				...gate ? [{
					title: "群感知",
					text: sourceText(gate.freeUsed, gate.limit, gate.freeRemaining)
				}] : [],
				{
					title: rechargeLabel,
					text: sourceText(value.paidUsed, value.paidLimit, value.paidRemaining)
				},
				...isPrivate || sameTarget ? [{
					title: "个人免费",
					text: sourceText(value.personalUsed, value.personalLimit, value.personalRemaining)
				}] : []
			];
			actions = [
				{
					label: "刷新",
					command: queryCommand
				},
				...event.IsMaster ? [{
					label: "记录",
					command: historyCommand
				}] : [],
				...sameTarget ? [{
					label: keyName,
					command: keyCommand
				}] : []
			];
			text = [[notice.trim(), `${target} · ${value.day}`].filter(Boolean).join("\n"), ...[
				`可用：${money(value.available)} 元${gate?.blocked ? "（感知预算不足）" : value.blocked ? "（不足）" : ""}`,
				groupKey?.enabled ? `群共享池优先（已启用 ${groupKey.active} / ${groupKey.count} 把，调用时校验），余额不足依次换钥匙；池用尽后使用本人的 Key，再使用内部额度。` : personal?.enabled ? "当前使用本人的个人 Key，不扣内部额度，也不供其他群友使用。" : "",
				event.IsPrivate && event.IsMaster ? `全局今日已用 ${money(value.globalUsed)} 元${value.globalLimit > 0 ? ` / 上限 ${money(value.globalLimit)} 元` : "（未设上限）"}` : "",
				value.blocked && !groupKey?.enabled && !personal?.enabled ? isPrivate ? "额度不足：可绑定个人密钥或等免费额度北京时间零点重置；充值余额跨天保留。" : "额度不足：可增加群充值或绑定群密钥，也可等北京时间零点恢复免费额度。" : "",
				gate?.blocked && !groupKey?.enabled ? "感知不足：后台判断暂停，@我仍可使用。" : "",
				"免费额度北京时间零点重置；充值余额跨天保留。"
			].filter(Boolean)].join("\n");
		} catch (error) {
			text = adjustmentReceipt ? `${targetDescription}\n${adjustmentReceipt}\n调整已保存，但最新余额暂时无法读取。请先查询目标额度核对，不要重复增加。` : error instanceof Error && error.message === budgetHelp ? "没有识别出这次额度操作。请先查看额度帮助，再选择查询或调整。" : toUserMessage(error);
			actions.push({
				label: "操作帮助",
				command: "/额度 帮助"
			});
		}
	}
	if (getSponsors().enabled) actions.push({
		label: "赞助列表",
		command: "/赞助列表"
	});
	if (budgetEnabled(config) && getAds().enabled) actions.push({
		label: "广告列表",
		command: "/广告列表"
	});
	await message.send({ format: sources ? sectionBubble("今日额度", text, sources, {
		platform: event.Platform,
		actions
	}) : commandBubble(text, "今日额度", {
		platform: event.Platform,
		actions
	}) });
};

export { res_default as default };