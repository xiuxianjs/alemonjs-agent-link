import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMemoryStore } from "../../memory/store.js";
import "../../dsh/client.js";
import { MemoryConsolidator } from "../../memory/consolidation.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { canPrivateChat, canReset, getConversationId } from "../dsh/util.js";
import { resetGroupSession, runCoordinatedChat } from "../../dsh/orchestrator.js";
import { forgetMemory, synchronizeExplicitMemory } from "../../memory/management.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

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
	const reply = async (text) => {
		const chars = Array.from(text);
		for (let index = 0; index < chars.length; index += replyLimit) assertMessageDelivered(await message.send({ format: Format.create().addText(chars.slice(index, index + replyLimit).join("")) }));
	};
	let coordinated;
	try {
		const config = getDSHConfig();
		replyLimit = Math.min(900, config.maxMessageLength);
		if (event.IsPrivate && !canPrivateChat(event, config.privateChatAccess)) {
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
		if ([
			"/恢复记忆",
			"/整理记忆",
			"/忘记群记忆"
		].includes(command) && !event.IsPrivate && !canReset(event)) {
			await reply("群记忆整理和修改需要管理员或机器人主人。");
			return;
		}
		const scope = {
			platform: event.Platform,
			channelId
		};
		const store = getMemoryStore(config);
		await synchronizeExplicitMemory(config, scope, event.UserId);
		if (command === "/群记忆" || command === "/过时记忆" || command === "/记忆检索") {
			if (command === "/记忆检索" && !args) {
				await reply("用法：/记忆检索 关键词。");
				return;
			}
			const items = command === "/记忆检索" ? store.recall(scope, args, event.UserId, 10) : store.list(scope, {
				status: command === "/过时记忆" ? "outdated" : "active",
				limit: 15
			});
			await reply(items.length ? items.map((item) => `${item.id} [${item.subjectName || item.subjectId}] ${item.text.slice(0, 220)}${item.origin === "explicit" ? "（明确保存）" : "（自动资料，请核对）"}`).join("\n") : "当前会话没有找到相关记忆。可用 /记忆来源 编号 核对原文。");
			return;
		}
		if (command === "/记忆来源") {
			const item = store.get(scope, args);
			await reply(item ? [
				`${item.id} [${item.status}] ${item.text}`,
				`资料所属：${item.subjectName || item.subjectId}；更新时间：${formatTime(item.updatedAt)}`,
				item.sourceRefs.length ? item.sourceRefs.slice(-3).map((source) => `来源 #${source.seq} ${source.speaker} ${formatTime(source.timestamp)}\n${source.text.slice(0, 500)}`).join("\n") : "用户明确保存；没有自动提取的聊天来源。",
				item.supersedes.length ? `取代的旧条目：${item.supersedes.join("、")}` : ""
			].filter(Boolean).join("\n") : "当前会话没有找到这个编号。");
			return;
		}
		if (command === "/恢复记忆") {
			if (!/^[a-f0-9]{12}$/u.test(args)) {
				await reply("用法：/恢复记忆 编号。先用 /过时记忆 查看。");
				return;
			}
			let restored = false;
			await resetGroupSession(channelId, config, () => {
				restored = store.restore(scope, args);
				return Promise.resolve();
			});
			await reply(restored ? "旧记忆已恢复，与它冲突的当前版本已标记过时。已开始新话题。" : "没有找到可恢复的旧记忆。");
			return;
		}
		if (command === "/忘记群记忆") {
			if (event.IsPrivate || !/^(?:全部|[a-f0-9]{12})$/u.test(args)) {
				await reply("在群里使用 /忘记群记忆 编号 或 /忘记群记忆 全部。");
				return;
			}
			let status = "missing";
			await resetGroupSession(channelId, config, async () => {
				status = await forgetMemory(config, scope, event.UserId, args === "全部" ? void 0 : args);
			});
			await reply(status === "ok" ? "指定群记忆及相关版本已删除，旧归档不会自动重新整理这些内容。已开始新话题。" : "没有找到这个群记忆编号。");
			return;
		}
		if (command === "/整理记忆") {
			if (args) {
				await reply("用法：/整理记忆。仅整理当前会话尚未处理的归档。");
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
					const applied = await worker.consolidate(scope, true, signal);
					result = {
						...applied,
						hasMore: Boolean(applied.hasMore)
					};
				} });
				if (coordinated.duplicate) return;
				await reply(result.status === "completed" ? `本次新增或更新 ${result.added} 条记忆。${result.hasMore ? "还有未处理记录，可再次整理。" : "当前可用记录已处理。"}` : result.status === "stale" ? "整理期间记忆发生修改，旧结果未写入。请重新整理。" : "记忆整理暂不可用或正在执行，请稍后重试。");
				await coordinated.confirmDelivery();
			} finally {
				worker.stop();
			}
		}
	} catch {
		await coordinated?.release().catch(() => void 0);
		await reply("记忆操作未完整完成，请稍后核对记忆与来源。");
	}
};

export { res_default as default };