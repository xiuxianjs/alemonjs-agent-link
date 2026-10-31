import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMemoryStore } from "../../memory/store.js";
import { MemoryConsolidator } from "../../memory/consolidation.js";
import "../../dsh/client.js";
import { canManageConversation, canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { resetGroupSession, runCoordinatedChat } from "../../dsh/orchestrator.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { forgetMemory, synchronizeExplicitMemory } from "../../memory/management.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/memory-tools/res.ts
const formatTime = (time) => new Date(time).toLocaleString("zh-CN", {
	timeZone: "Asia/Shanghai",
	hour12: false
});
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	let replyLimit = 900;
	const reply = async (text, actions) => {
		const chars = Array.from(text);
		const chunks = [];
		for (let index = 0; index < chars.length; index += replyLimit) chunks.push(chars.slice(index, index + replyLimit).join(""));
		for (const [index, chunk] of chunks.entries()) assertMessageDelivered(await message.send({ format: commandBubble(chunk, "记忆查询与管理", {
			platform: event.Platform,
			actions: index === chunks.length - 1 ? actions ?? [
				{
					label: "查看记忆",
					command: event.IsPrivate ? "/记忆" : "/群记忆"
				},
				{
					label: "过时记忆",
					command: "/过时记忆"
				},
				{
					label: "帮助",
					command: "/帮助 记忆"
				}
			] : []
		}) }));
	};
	let coordinated;
	try {
		const config = getDSHConfig();
		replyLimit = Math.min(900, config.maxMessageLength);
		if (event.IsPrivate && !await canPrivateChatWithKey(event, config.privateChatAccess)) {
			await reply("当前未开放此私聊。");
			return;
		}
		const channelId = getConversationId(event);
		if (!channelId || !event.Platform || !event.UserId) {
			await reply("无法识别当前会话。");
			return;
		}
		const command = event.MessageText.trim().split(/\s+/u)[0];
		const args = route.rawArgs.join(" ").trim();
		const canManage = event.IsPrivate || await canManageConversation(event);
		if ([
			"/恢复记忆",
			"/整理记忆",
			"/忘记群记忆"
		].includes(command) && !event.IsPrivate && !canManage) {
			await reply("群记忆整理和修改需要管理员或机器人主人。");
			return;
		}
		const scope = {
			platform: event.Platform,
			channelId,
			botId: event.BotId || ""
		};
		const store = getMemoryStore(config);
		await synchronizeExplicitMemory(config, scope, event.UserId);
		if (command === "/群记忆" || command === "/过时记忆" || command === "/记忆检索") {
			if (command === "/记忆检索" && !args) {
				await reply("想找哪方面的记忆？在指令后写关键词。\n例如：/记忆检索 饮食偏好");
				return;
			}
			if (command !== "/记忆检索" && args && !/^[1-9]\d*$/u.test(args)) {
				await reply("请用下方入口查看记忆，再选择对应条目的操作。");
				return;
			}
			const items = command === "/记忆检索" ? store.recall(scope, args, event.UserId, 10) : store.list(scope, {
				status: command === "/过时记忆" ? "outdated" : "active",
				limit: 10020
			});
			if (!items.length) {
				await reply("未找到相关记忆。");
				return;
			}
			const sections = items.map((item) => {
				const actions = [{
					label: "全文与来源",
					command: `/记忆来源 ${item.id}`
				}];
				if (command === "/过时记忆" && canManage) actions.push({
					label: "恢复",
					command: `/恢复记忆 ${item.id}`
				});
				else if (event.IsPrivate) actions.push({
					label: "忘记",
					command: `/忘记 ${item.id}`
				});
				else if (canManage) actions.push({
					label: "忘记",
					command: `/忘记群记忆 ${item.id}`
				});
				return {
					title: `[${Array.from(item.subjectName || item.subjectId).slice(0, 24).join("")}] ${{
						explicit: "明确保存",
						extracted: "聊天整理",
						event: "阅读经历",
						diary: "日记"
					}[item.origin]}`,
					text: `${Array.from(item.text).slice(0, 60).join("")}${Array.from(item.text).length > 60 ? "…" : ""}`,
					actions
				};
			});
			const footer = [
				...command === "/记忆检索" ? [{
					label: event.IsPrivate ? "我的记忆" : "群记忆",
					command: event.IsPrivate ? "/记忆" : "/群记忆"
				}] : [],
				...command === "/过时记忆" ? [{
					label: "当前记忆",
					command: event.IsPrivate ? "/记忆" : "/群记忆"
				}] : [{
					label: "过时记忆",
					command: "/过时记忆"
				}],
				{
					label: "帮助",
					command: "/帮助 记忆"
				}
			];
			assertMessageDelivered(await message.send({ format: sectionBubble(command === "/记忆检索" ? "记忆检索" : command === "/过时记忆" ? "过时记忆" : "群记忆", command === "/记忆检索" ? "按相关程度显示前10条；全文与来源可查看完整内容。" : `共 ${items.length} 条；全文与来源可查看完整内容。`, sections, {
				platform: event.Platform,
				layout: "inline",
				...command !== "/记忆检索" ? { page: {
					current: Number(args) || 1,
					size: 5,
					command
				} } : {},
				actions: footer
			}) }));
			return;
		}
		if (command === "/记忆来源") {
			const match = args.match(/^([a-f0-9]{8}(?:[a-f0-9]{4})?)(?:\s+([1-9]\d*))?$/u);
			const item = match ? store.get(scope, match[1]) : void 0;
			if (!item) {
				await reply("当前会话没有找到这条记忆。请返回列表，在对应条目旁选择「全文与来源」。");
				return;
			}
			const sources = [...item.sourceRefs].reverse();
			const pages = Math.max(1, sources.length);
			const page = Math.min(pages, Number(match[2]) || 1);
			const source = sources[page - 1];
			const origin = {
				explicit: "明确保存",
				extracted: "聊天整理",
				event: "阅读经历",
				diary: "日记"
			}[item.origin];
			await reply([
				`记忆内容：${item.text}`,
				`状态：${item.status === "active" ? "当前使用" : "已过时"}；记录方式：${origin}`,
				`资料所属：${item.subjectName || item.subjectId}；更新时间：${formatTime(item.updatedAt)}`,
				source ? `聊天来源 ${page}/${pages}（由近到远）\n${source.speaker} · ${formatTime(source.timestamp)}\n${source.text}` : "没有关联的聊天原文。",
				item.supersedes.length ? `取代的旧条目：${item.supersedes.join("、")}` : ""
			].filter(Boolean).join("\n\n"), [
				...page > 1 ? [{
					label: "上一条来源",
					command: `/记忆来源 ${item.id} ${page - 1}`
				}] : [],
				...page < pages ? [{
					label: "下一条来源",
					command: `/记忆来源 ${item.id} ${page + 1}`
				}] : [],
				...item.status === "outdated" && canManage ? [{
					label: "恢复记忆",
					command: `/恢复记忆 ${item.id}`
				}] : [],
				{
					label: "返回记忆",
					command: event.IsPrivate ? "/记忆" : "/群记忆"
				},
				{
					label: "过时记忆",
					command: "/过时记忆"
				}
			]);
			return;
		}
		if (command === "/恢复记忆") {
			if (!/^[a-f0-9]{12}$/u.test(args)) {
				await reply("请先找到要恢复的旧记忆，再点击该条目的「恢复」。", [{
					label: "选择旧记忆",
					command: "/过时记忆"
				}]);
				return;
			}
			let restored = false;
			await resetGroupSession(channelId, config, () => {
				restored = store.restore(scope, args);
				return Promise.resolve();
			});
			await reply(restored ? "旧记忆已恢复，冲突版本已标记过时；已开始新话题。" : "没有找到可恢复的旧记忆。");
			return;
		}
		if (command === "/忘记群记忆") {
			if (event.IsPrivate || !/^(?:全部|[a-f0-9]{12})$/u.test(args)) {
				await reply(event.IsPrivate ? "这里是私聊，请到自己的记忆列表选择要忘记的条目。" : "请在群记忆列表中找到要删除的条目，再点击「忘记」。", [{
					label: "选择记忆",
					command: event.IsPrivate ? "/记忆" : "/群记忆"
				}]);
				return;
			}
			let status = "missing";
			await resetGroupSession(channelId, config, async () => {
				status = await forgetMemory(config, scope, event.UserId, args === "全部" ? void 0 : args);
			});
			await reply(status === "ok" ? "群记忆及相关版本已删除，旧记录不会自动重新提取；已开始新话题。" : "没有找到这个群记忆编号。");
			return;
		}
		if (command === "/整理记忆") {
			if (args) {
				await reply("整理记忆无需填写其他内容，只会处理当前会话尚未整理的聊天归档。", [{
					label: "整理本会话",
					command: "/整理记忆"
				}]);
				return;
			}
			let result = {
				status: "busy",
				added: 0,
				hasMore: false
			};
			const worker = new MemoryConsolidator(config);
			try {
				coordinated = await runCoordinatedChat({
					...event,
					ChannelId: channelId
				}, event.MessageText, () => Promise.resolve(), void 0, void 0, void 0, void 0, { execute: async (signal) => {
					const applied = await worker.consolidate(scope, true, signal, event.UserId);
					result = {
						...applied,
						hasMore: Boolean(applied.hasMore)
					};
				} });
				if (coordinated.duplicate) return;
				await reply(result.status === "completed" ? `本次新增或更新 ${result.added} 条记忆。${result.hasMore ? "还有未处理记录，可再次整理。" : "当前可用记录已处理。"}` : result.status === "stale" ? "整理期间记忆发生修改，旧结果未写入。请重新整理。" : "记忆整理暂不可用或正在执行，请稍后重试。", [
					...result.hasMore || result.status === "stale" ? [{
						label: result.hasMore ? "继续整理" : "重新整理",
						command: "/整理记忆"
					}] : [],
					{
						label: "查看记忆",
						command: event.IsPrivate ? "/记忆" : "/群记忆"
					},
					{
						label: "记忆帮助",
						command: "/帮助 记忆"
					}
				]);
				await coordinated.confirmDelivery();
			} finally {
				worker.stop();
			}
		}
	} catch {
		await coordinated?.release().catch(() => void 0);
		await reply("记忆操作未完成，请核对后重试。");
	}
};

export { res_default as default };