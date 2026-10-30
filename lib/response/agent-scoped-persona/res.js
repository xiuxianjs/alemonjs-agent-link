import { personaDetailFields } from "../../companion/persona-details.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { readScopedPersona, saveScopedPersona } from "../../agent/scoped-persona.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-scoped-persona/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const identity = {
		platform: event.Platform || "",
		channelId: getConversationId(event),
		userId: event.UserId || "",
		owner: Boolean(event.IsMaster),
		private: Boolean(event.IsPrivate),
		admin: !event.IsPrivate && await verifyGroupKeyAdmin(event)
	};
	const config = getDSHConfig();
	const args = route.rawArgs.map(String).join(" ").trim();
	let text;
	try {
		const details = readScopedPersona(config, identity);
		const expected = { ...details };
		const match = args.match(/^(编辑|清空)\s+(\S+)(?:\s+([\s\S]+))?$/u);
		if (args === "恢复默认 确认") {
			await saveScopedPersona(config, identity, {}, expected);
			text = "已清除本会话的专属人设细节，恢复默认模板。";
		} else if (args === "恢复默认") text = "将清除本会话的专属细节。确认请发送 /人设 恢复默认 确认";
		else if (match) {
			const [, action, field, value] = match;
			if (!personaDetailFields.includes(field)) throw new Error("未知字段，请用 /人设 查看字段列表");
			if (action === "编辑" && !value?.trim()) throw new Error("用法：/人设 编辑 字段 内容");
			if (action === "清空") Reflect.deleteProperty(details, field);
			else details[field] = value;
			await saveScopedPersona(config, identity, details, expected);
			text = `已${action}本会话的「${field}」，后续对话生效。`;
		} else text = `本会话专属人设\n${Object.entries(details).map(([key, value]) => `${key}：${value}`).join("\n") || "当前使用默认模板"}\n\n可编辑字段：${personaDetailFields.join("、")}\n/人设 编辑 字段 内容\n/人设 清空 字段\n/人设 恢复默认`;
	} catch (error) {
		text = error instanceof Error ? error.message : "操作失败";
	}
	for (let offset = 0; offset < text.length; offset += 1200) await message.send({ format: commandBubble(text.slice(offset, offset + 1200), "专属人设", { platform: event.Platform }) });
};

export { res_default as default };