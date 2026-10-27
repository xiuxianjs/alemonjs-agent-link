import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMemoryStore } from "../../memory/store.js";
import { SessionRegistry, privateMemoryTextLimit } from "../../state/registry.js";
import "../../dsh/client.js";
import { canPrivateChat, getConversationId } from "../dsh/util.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { forgetMemory, synchronizeExplicitMemory } from "../../memory/management.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

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
		for (let index = 0; index < characters.length; index += maxLength) assertMessageDelivered(await message.send({ format: Format.create().addText(characters.slice(index, index + maxLength).join("")) }));
	};
	try {
		const config = getDSHConfig();
		maxLength = config.maxMessageLength;
		if (!canPrivateChat(event, config.privateChatAccess)) {
			await reply("仅机器人主人可在私聊中使用 Agent。");
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
			channelId
		};
		const args = route.rawArgs.join(" ").trim();
		const command = event.MessageText.trim().split(/\s+/u)[0];
		if (command === "/记忆") {
			await synchronizeExplicitMemory(config, scope, event.UserId);
			const notes = getMemoryStore(config).list(scope, {
				status: "active",
				limit: 10
			});
			await reply(notes.length ? notes.map((note) => `${note.id}：${note.text.slice(0, 80)}${note.text.length > 80 ? "…" : ""}${note.origin === "explicit" ? "" : "（自动）"}`).join("\n") + "\n仅展示最近10条；/记忆检索 关键词，/记忆来源 编号 查看详情。" : "暂无长期记忆，可发送 /记住 内容。");
			return;
		}
		if (command === "/记住" && (!args || Array.from(args).length > 200)) {
			await reply(`用法：/记住 内容（最多 ${200} 字）。`);
			return;
		}
		if (command === "/忘记" && !/^[a-f0-9]{8}(?:[a-f0-9]{4})?$/u.test(args)) {
			await reply("用法：/忘记 编号；/记忆 查看编号。");
			return;
		}
		const action = command === "/记住" ? "add" : command === "/忘记" ? "remove" : command === "/忘记全部" ? "clear" : null;
		if (!action || command === "/忘记全部" && args) {
			await reply("用法：/记忆、/记住 内容、/忘记 编号、/忘记全部。");
			return;
		}
		let status = "";
		await resetGroupSession(channelId, config, async () => {
			if (action === "add") {
				const changed = await registry.changePrivateMemory(channelId, action, args);
				status = changed.status;
				getMemoryStore(config).syncExplicit(scope, event.UserId, changed.notes);
			} else status = await forgetMemory(config, scope, event.UserId, action === "clear" ? void 0 : args);
		});
		await reply(status === "full" ? "长期记忆已满（20 条），请先用 /忘记 编号 删除旧条目。" : status === "missing" ? "没有找到这个编号，请用 /记忆 查看。" : status === "exists" ? "这条记忆已经保存。已开始新话题。" : action === "add" ? "记忆已保存，已开始新话题。" : "记忆已删除，已开始新话题。");
	} catch {
		await reply("操作未完成，请用 /记忆 核对，必要时 /新会话。");
	}
};

export { res_default as default };