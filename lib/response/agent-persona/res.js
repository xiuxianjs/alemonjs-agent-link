import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getPersonaStore, validPersonaId } from "../../companion/personas.js";
import "../../dsh/client.js";
import { canPrivateChat, canReset, getConversationId } from "../dsh/util.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-persona/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	let limit = 900;
	const reply = async (text) => {
		const chars = Array.from(text);
		for (let i = 0; i < chars.length; i += limit) assertMessageDelivered(await message.send({ format: Format.create().addText(chars.slice(i, i + limit).join("")) }));
	};
	try {
		const config = getDSHConfig();
		limit = Math.min(900, config.maxMessageLength);
		if (event.IsPrivate && !canPrivateChat(event, config.privateChatAccess)) {
			await reply("当前未开放此私聊。");
			return;
		}
		const channelId = getConversationId(event);
		if (!channelId || !event.Platform) {
			await reply("无法识别当前会话。");
			return;
		}
		if (config.modules?.disabled?.includes("persona")) {
			await reply("人格模块已停用。");
			return;
		}
		const store = getPersonaStore(config);
		const scope = {
			platform: event.Platform,
			channelId
		};
		const args = route.rawArgs.join(" ").trim();
		if (!args || args === "列表") {
			await reply(`当前人格：${store.selected(scope) || config.modules?.settings?.persona?.defaultId || "配置默认"}\n${(await store.list()).map((row) => `${row.id}：${row.name}${row.error ? "（文件无效）" : ""}`).join("\n")}\n使用：/人格 使用 编号；/人格 使用 默认。切换会开始新话题。`);
			if (event.IsPrivate && event.IsMaster) await reply("主人管理：/人格 追加 编号 内容；/人格 查看追加 编号；/人格 清空追加 编号；/人格 查看 编号；/人格 保存 编号 名称|提示词；/人格 删除 编号。完整规则可编辑本地 personas/*.json，下一轮读取。");
			return;
		}
		const match = args.match(/^(使用|查看|保存|删除|追加|查看追加|清空追加)\s+([a-z][a-z0-9-]{0,63}|默认)(?:\s+([\s\S]+))?$/u);
		if (!match || match[2] !== "默认" && !validPersonaId(match[2])) {
			await reply("用法：/人格 使用 编号。用 /人格 列表 查看可用编号。");
			return;
		}
		const [, action, id, body] = match;
		if (action === "使用") {
			if (body || !event.IsPrivate && !canReset(event)) {
				await reply("群内切换人格需要管理员或机器人主人，且只能指定一个编号。");
				return;
			}
			if (id !== "默认") await store.read(id);
			await resetGroupSession(channelId, config, () => store.select(scope, id === "默认" ? void 0 : id));
			await reply("当前会话的人格已切换，已开始新话题。");
			return;
		}
		if (!event.IsMaster || !event.IsPrivate) {
			await reply("人格文件管理仅限机器人主人私聊。");
			return;
		}
		if (id === "默认") {
			await reply("请指定实际人格编号。");
			return;
		}
		if (action === "追加" && body) {
			await store.read(id);
			if (store.additions(id).length + body.trim().length + 1 > 4e3) {
				await reply("追加人设累计最多 4000 字符，请先查看或清空追加内容。");
				return;
			}
			store.append(id, body);
			await reply(`已追加到 ${id}，保留原人设。所有使用该人格的会话下一轮生效，进行中的回复不变。`);
		} else if (action === "查看追加" && !body) {
			await store.read(id);
			await reply(store.additions(id) || "这个人格还没有追加设定。");
		} else if (action === "清空追加" && !body) {
			await store.read(id);
			store.clearAdditions(id);
			await reply("追加设定已清空，原人设保留；使用该人格的会话下一轮生效。");
		} else if (action === "查看" && !body) {
			const persona = await store.read(id);
			await reply(JSON.stringify(persona, null, 2));
		} else if (action === "保存" && body?.includes("|")) {
			const split = body.indexOf("|");
			const existing = (await store.list()).some((row) => row.id === id) ? await store.read(id) : void 0;
			await store.save({
				...existing,
				id,
				name: body.slice(0, split).trim(),
				prompt: body.slice(split + 1).trim()
			});
			await reply("人格文件已保存，下一轮请求生效。既有进行中的请求仍使用原有快照。");
		} else if (action === "删除" && !body) {
			if (config.modules?.settings?.persona?.defaultId === id) {
				await reply("请先修改配置中的 persona.defaultId，再删除这个人格文件。");
				return;
			}
			for (const selected of store.scopesUsing(id)) await resetGroupSession(selected.channelId, config, () => store.select(selected));
			await store.remove(id);
			await reply("人格文件已删除，使用它的会话已回到默认；内置编号的覆盖文件删除后恢复内置内容。");
		} else await reply("保存格式：/人格 保存 编号 名称|提示词；查看和删除只接受编号。");
	} catch {
		await reply("人格操作未完整完成，请检查编号、文件格式及会话状态后重试。");
	}
};

export { res_default as default };