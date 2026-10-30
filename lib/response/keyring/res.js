import { DSHError } from "../../dsh/errors.js";
import { groupKeyBudgetStatus, setGroupKeyDailyLimit } from "../../billing/budget.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { bindPersonalKey, personalKeyStatus, personalStorageKey, updatePersonalKey } from "../../credentials/personal.js";
import { credentialStateLabel, groupKeyEntries, groupKeyStatus, setGroupKeyState } from "../../credentials/group.js";
import "../../dsh/client.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { changeKeyring, grantLimitDetails, keyringStorageKey, readKeyring, removeCurrentGroupKey, setGrantDailyLimit, setGrantState } from "../../credentials/keyring.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { storedKeyBalance } from "../../credentials/key-balance.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/keyring/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const [message] = useMessage();
	await handleKeyringCommand(event, message);
};
const handleKeyringCommand = async (event, message) => {
	const [command, ...args] = (event.MessageText || "").trim().split(/\s+/u);
	const scope = {
		platform: event.Platform || "",
		userId: event.UserId || "",
		channelId: getConversationId(event)
	};
	let text = "";
	let actions = [{
		label: "我的钥匙",
		command: "/我的钥匙"
	}];
	try {
		if ([
			"/个人密钥",
			"/apikey",
			"/群密钥",
			"/groupapikey"
		].includes(command)) {
			await message.send({ format: commandBubble("旧密钥入口已停用，请使用 /我的钥匙；群授权通过 /授权钥匙 编号，私聊 /授权记录 可撤销。", "我的钥匙", {
				platform: event.Platform,
				actions: [{
					label: "我的钥匙",
					command: "/我的钥匙"
				}]
			}) });
			return;
		}
		if (!event.IsPrivate && !await verifyGroupKeyAdmin(event)) throw new DSHError("budget", "仅本群管理员可查看、授权和移除群聊钥匙。");
		if (command === "/我的钥匙" && !event.IsPrivate && args.length === 2 && args[0] === "上限") {
			await setGroupKeyDailyLimit(scope, args[1]);
			text = args[1] === "取消" ? "已取消群管理员设置的上限；提供者上限仍然有效，当日用量保留。" : "群共享池每日总上限已保存；每次分享的上限独立计量。";
		} else if (command === "/我的钥匙" && !event.IsPrivate && args.length === 1 && ["启用", "停用"].includes(args[0])) text = await setGroupKeyState(scope, args[0] === "启用") ? `本群钥匙已${args[0]}。${args[0] === "停用" ? "后续使用发言人的个人钥匙，再使用额度。" : "后续优先使用本群钥匙。"}` : "本群尚未授权钥匙。";
		else if (command === "/我的钥匙" && !event.IsPrivate && args.length === 1 && args[0] === "移除") text = await removeCurrentGroupKey(scope) ? "本群钥匙已移除，后续使用发言人的个人钥匙，再使用额度；已发出的请求可能继续完成。" : "本群尚未授权钥匙。";
		else if (command === "/授权记录") {
			if (!event.IsPrivate) throw new DSHError("budget", "请私聊查看授权记录。");
			if (args.length === 3 && args[0] === "上限") {
				await setGrantDailyLimit(scope, args[1], args[2]);
				text = "授权每日上限已保存，群管理员不能提高此上限。";
			} else if (args.length === 2 && ["启用", "停用"].includes(args[0])) {
				await setGrantState(scope, args[1], args[0] === "启用");
				text = "该次分享状态已更新，用量保留；启用后会在调用时重新校验。";
			} else if (args.length === 2 && args[0] === "移除") {
				await changeKeyring(scope, "revoke", args[1]);
				text = "授权已移除，对应群副本已撤销；已发出的请求可能继续完成。";
			} else if (!args.length) {
				const { ring } = await readKeyring(scope);
				const current = await Promise.all(ring.grants.map((item) => grantLimitDetails(scope, item)));
				const sections = ring.grants.length ? ring.grants.map((item, index) => ({
					title: `记录 ${item.id}`,
					text: `群 ${item.channelId} · 钥匙 ${item.keyId} · ${current[index] ? current[index].label : "授权已失效"}${current[index] ? `\n提供者上限：${current[index].donor === null ? "未设置" : `${current[index].donor} 元/日`}；群上限：${current[index].group === null ? "未设置" : `${current[index].group} 元/日`}；生效上限：${current[index].effective === null ? "未设置" : `${current[index].effective} 元/日`}` : ""}`,
					actions: [...current[index] ? [{
						label: current[index].enabled ? "停用" : "启用",
						command: `/授权记录 ${current[index].enabled ? "停用" : "启用"} ${item.id}`
					}] : [], {
						label: current[index] ? "移除授权" : "清理记录",
						command: `/授权记录 移除 ${item.id}`
					}]
				})) : [{
					title: "还没有授权",
					text: "在目标群发 /授权钥匙 编号 后，这里会出现记录。",
					actions: [{
						label: "我的钥匙",
						command: "/我的钥匙"
					}]
				}];
				await message.send({ format: sectionBubble("授权记录", "仅本人可查。设置每日上限：/授权记录 上限 记录编号 金额。", sections, { platform: event.Platform }) });
				return;
			} else throw new DSHError("budget", "用法：/授权记录、/授权记录 移除 编号、/授权记录 上限 编号 金额");
		} else if (command === "/授权钥匙") {
			if (event.IsPrivate || args.length !== 1) throw new DSHError("budget", "请管理员在目标群发送 /授权钥匙 编号。");
			await changeKeyring(scope, "grant", args[0]);
			text = "本群钥匙已授权，已加入共享池，供全群使用。";
		} else if (event.IsPrivate && args[0] === "私聊") {
			if (args[1] === "添加" && args.length === 3) {
				await bindPersonalKey(scope, args[2]);
				text = "个人钥匙已保存，用于本人私聊及本人触发的群回复，不分享给其他群友。";
			} else if (args.length === 2 && [
				"启用",
				"停用",
				"移除"
			].includes(args[1])) text = await updatePersonalKey(scope, {
				启用: "enable",
				停用: "disable",
				移除: "remove"
			}[args[1]]) ? "私聊钥匙状态已更新。" : "暂无私聊钥匙。";
			else {
				const status = await personalKeyStatus(scope);
				text = `剩余额度：${status.bound ? await storedKeyBalance(personalStorageKey(scope), scope) : "未绑定"}\n${status.bound ? `私聊钥匙 1：${credentialStateLabel(status)}` : "暂无私聊钥匙"}\n/我的钥匙 私聊 添加 sk-你的Key\n/我的钥匙 私聊 启用（或停用、移除）`;
				actions = status.bound ? [
					{
						label: status.enabled ? "停用" : "启用",
						command: `/我的钥匙 私聊 ${status.enabled ? "停用" : "启用"}`
					},
					{
						label: "移除",
						command: "/我的钥匙 私聊 移除"
					},
					{
						label: "额度",
						command: "/额度"
					}
				] : [{
					label: "添加钥匙",
					command: "/我的钥匙 私聊 添加 sk-你的Key"
				}, {
					label: "个人登录",
					command: "/个人登录"
				}];
			}
		} else if (event.IsPrivate && args[0] === "群聊" && args[1] === "添加" && args.length === 3) {
			await changeKeyring(scope, "add", args[2]);
			text = "群聊钥匙已保存，请到目标群查看 /我的钥匙 并授权。";
			actions = [{
				label: "我的钥匙",
				command: "/我的钥匙"
			}];
		} else if (!args.length || event.IsPrivate && args.length === 1 && args[0] === "群聊") {
			const { ring } = await readKeyring(scope);
			const balances = [];
			for (const item of ring.keys) balances.push(event.IsPrivate ? await storedKeyBalance(keyringStorageKey(scope), scope, item.value) : "");
			const sections = ring.keys.length ? ring.keys.map((item, index) => ({
				title: `钥匙 ${item.id}`,
				text: `${item.value.auth === "account" ? "群聊专用 · 扫码账户" : "群聊专用"}${event.IsPrivate ? `\n剩余额度：${balances[index]}` : ""}`,
				actions: event.IsPrivate ? [] : [{
					label: "授权钥匙",
					command: `/授权钥匙 ${item.id}`
				}]
			})) : [{
				title: event.IsPrivate ? "还没有钥匙" : "还没有可用钥匙",
				text: event.IsPrivate ? "可以先扫码准备，或手动添加群聊钥匙。" : "请先私聊机器人添加群聊钥匙，再回本群授权。",
				actions: []
			}];
			if (!event.IsPrivate) {
				const status = await groupKeyStatus(scope);
				const usage = await groupKeyBudgetStatus(getDSHConfig(), scope);
				sections.push({
					title: "群钥匙每日预算",
					text: usage.groupLimit !== null ? `今日已用及预占 ${usage.groupUsed} / ${usage.groupLimit} 元；剩余 ${usage.groupRemaining} 元` : `未设置群总上限；各提供者上限见下方。今日已计量及预占 ${usage.groupUsed} 元。仅统计本功能上线后的可计量文字调用。图片和沙箱费用不在此数内。`,
					actions: [{
						label: "取消群上限",
						command: "/我的钥匙 上限 取消"
					}]
				});
				for (const [index, entry] of (await groupKeyEntries(scope)).entries()) {
					const detail = await groupKeyBudgetStatus(getDSHConfig(), entry.scope);
					sections.push({
						title: `共享钥匙 ${index + 1}`,
						text: `${entry.label}\n本次分享今日已用及预占 ${detail.donorUsed} 元；提供者上限：${detail.donorLimit === null ? "未设置" : `${detail.donorLimit} 元/日；剩余 ${detail.donorRemaining} 元`}。`,
						actions: []
					});
				}
				sections.unshift({
					title: "本群钥匙",
					text: status.bound ? `已分享 ${status.count} 把，已启用 ${status.active} 把（不代表余额或授权有效）。\n按顺序使用，余额不足换下一把；全部不可用时使用发言人自己的钥匙，再使用已有充值和免费额度。` : "尚未授权",
					actions: status.bound ? [{
						label: status.enabled ? "停用" : "启用",
						command: `/我的钥匙 ${status.enabled ? "停用" : "启用"}`
					}, {
						label: "移除",
						command: "/我的钥匙 移除"
					}] : []
				});
			}
			if (event.IsPrivate) {
				const personal = await personalKeyStatus(scope);
				sections.unshift({
					title: "私聊钥匙 1",
					text: personal.bound ? `剩余额度：${await storedKeyBalance(personalStorageKey(scope), scope)}` : "未绑定",
					actions: [{
						label: "私聊钥匙",
						command: "/我的钥匙 私聊"
					}]
				});
				sections.push({
					title: "添加或登录",
					text: "扫码可同时准备私聊和群聊钥匙。",
					actions: [
						{
							label: "个人登录",
							command: "/个人登录"
						},
						{
							label: "添加群聊钥匙",
							command: "/我的钥匙 群聊 添加 sk-你的Key"
						},
						{
							label: "授权记录",
							command: "/授权记录"
						}
					]
				});
			}
			await message.send({ format: sectionBubble("我的钥匙", event.IsPrivate ? "仅本人可查。" : "本群管理员可移除本群钥匙；下方仅列出你可授权的钥匙编号。", sections, { platform: event.Platform }) });
			return;
		} else text = "请使用 /我的钥匙；密钥只在私聊添加。";
	} catch (error) {
		text = error instanceof DSHError ? error.message : "钥匙操作失败，请稍后重试。";
	}
	await message.send({ format: commandBubble(text, "我的钥匙", {
		platform: event.Platform,
		actions
	}) });
};

export { res_default as default, handleKeyringCommand };