import { getDSHConfig } from "../../dsh/runtime-config.js";
import { conversationQueueScope } from "../../dsh/conversation-scope.js";
import { getMemoryStore } from "../../memory/store.js";
import { SessionRegistry, privateMemoryTextLimit } from "../../state/registry.js";
import "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { forgetMemory, synchronizeExplicitMemory } from "../../memory/management.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-memory/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	let maxLength = 1e3;
	const reply = async (text) => {
		const characters = Array.from(text);
		const chunks = [];
		for (let index = 0; index < characters.length; index += maxLength) chunks.push(characters.slice(index, index + maxLength).join(""));
		for (const [index, chunk] of chunks.entries()) assertMessageDelivered(await message.send({ format: commandBubble(chunk, "我的记忆", {
			platform: event.Platform,
			actions: index === chunks.length - 1 ? [
				{
					label: "查看记忆",
					command: event.IsPrivate ? "/记忆" : "/群记忆"
				},
				{
					label: "记忆检索",
					command: "/记忆检索"
				},
				{
					label: "帮助",
					command: "/帮助 记忆"
				}
			] : []
		}) }));
	};
	try {
		const config = getDSHConfig();
		maxLength = Math.min(900, config.maxMessageLength);
		if (!await canPrivateChatWithKey(event, config.privateChatAccess)) {
			await reply("当前未开放此私聊。");
			return;
		}
		const channelId = getConversationId(event);
		if (!channelId) {
			await reply("无法识别当前会话。");
			return;
		}
		const registry = new SessionRegistry(config);
		const scope = {
			platform: event.Platform,
			channelId,
			botId: event.BotId || ""
		};
		const args = route.rawArgs.join(" ").trim();
		const command = event.MessageText.trim().split(/\s+/u)[0];
		if (command === "/记忆") {
			if (args && !/^[1-9]\d*$/u.test(args)) {
				await reply("请用下方入口查看记忆，再选择对应条目的操作。");
				return;
			}
			await synchronizeExplicitMemory(config, scope, event.UserId);
			const notes = getMemoryStore(config).list(scope, {
				status: "active",
				limit: 10020
			});
			if (!notes.length) {
				await reply("我还没有保存长期记忆。\n想让我记住什么偏好？可以这样发：\n/记住 回答时先说结论\n保存后用 /记忆 查看；不想保留时用 /忘记 编号 删除。");
				return;
			}
			const sections = notes.map((note) => ({
				title: `${note.id}${note.origin === "explicit" ? " · 手动" : " · 自动"}`,
				text: `${Array.from(note.text).slice(0, 60).join("")}${Array.from(note.text).length > 60 ? "…" : ""}`,
				actions: [{
					label: "全文与来源",
					command: `/记忆来源 ${note.id}`
				}, {
					label: "忘记",
					command: `/忘记 ${note.id}`
				}]
			}));
			assertMessageDelivered(await message.send({ format: sectionBubble("我的记忆", `共 ${notes.length} 条；全文与来源可查看完整内容。删除记忆不会同时删除聊天记录。`, sections, {
				platform: event.Platform,
				page: {
					current: Number(args) || 1,
					size: 5,
					command: "/记忆"
				},
				actions: [
					{
						label: "记住偏好",
						command: "/记住 "
					},
					{
						label: "检索",
						command: "/记忆检索 "
					},
					{
						label: "帮助",
						command: "/帮助 记忆"
					}
				]
			}) }));
			return;
		}
		if (command === "/记住" && (!args || Array.from(args).length > 200)) {
			await reply(`想让我记住什么？发 /记住 内容 就行，最多 ${200} 字。`);
			return;
		}
		if (command === "/忘记" && !/^[a-f0-9]{8}(?:[a-f0-9]{4})?$/u.test(args)) {
			await reply("想删掉哪条记忆？发 /忘记 编号；编号可以用 /记忆 查看。");
			return;
		}
		const action = command === "/记住" ? "add" : command === "/忘记" ? "remove" : command === "/忘记全部" ? "clear" : null;
		if (!action || command === "/忘记全部" && args) {
			await reply("没有识别出这项记忆操作。请先查看记忆，再选择要修改的条目。");
			return;
		}
		let status = "";
		await resetGroupSession(channelId, config, async () => {
			if (action === "add") {
				const changed = await registry.changePrivateMemory(channelId, action, args, void 0, conversationQueueScope(config, scope));
				status = changed.status;
				getMemoryStore(config).syncExplicit(scope, event.UserId, changed.notes);
			} else status = await forgetMemory(config, scope, event.UserId, action === "clear" ? void 0 : args);
		});
		await reply(status === "full" ? "已经记满 20 条了。先用 /忘记 编号 删掉不再需要的，再记新的吧。" : status === "missing" ? "我没找到这条记忆，用 /记忆 核对一下编号吧。" : status === "exists" ? "这条之前就记下了，不用重复记。当前会话已经切到新话题了。" : action === "add" ? "记下了。接下来从新话题开始聊。" : "记忆已删除，聊天记录仍然保留。接下来从新话题开始聊。");
	} catch {
		await reply("这次操作没能完成，先用 /记忆 核对一下，必要时再发 /新会话。");
	}
};

export { res_default as default };