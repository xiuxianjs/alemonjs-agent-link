import { getDSHConfig } from "../../dsh/runtime-config.js";
import { personaDetailFields } from "../../companion/persona-details.js";
import { resolveIntelligenceAccess } from "../../agent/intelligence.js";
import { readScopedPersona, saveScopedPersona } from "../../agent/scoped-persona.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble, sectionBubble } from "../bubble.js";
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
	let actions = [{
		label: "返回人设",
		command: "/人设"
	}];
	const fieldActions = (field, editable) => {
		const page = Math.floor(personaDetailFields.indexOf(field) / 4) + 1;
		return [
			...editable ? [{
				label: "编辑",
				command: `/人设 编辑 ${field} `
			}] : [],
			{
				label: "查看字段",
				command: `/人设 查看 ${field}`
			},
			{
				label: `返回第${page}页`,
				command: `/人设 ${page}`
			}
		];
	};
	try {
		const details = readScopedPersona(config, identity);
		const expected = { ...details };
		const access = await resolveIntelligenceAccess(identity, config);
		const match = args.match(/^(编辑|清空)\s+(\S+)(?:\s+([\s\S]+))?$/u);
		if (args === "恢复默认" || args === "恢复默认 确认") {
			if (!access.canEdit) throw new Error("当前没有修改权限，请用 /我的权限 查看权益。");
		}
		if (args === "恢复默认 确认") {
			await saveScopedPersona(config, identity, {}, expected);
			text = "已清除本会话的专属人设细节，后续沿用当前人格模板。人格选择和群人设补充未修改。";
		} else if (args === "恢复默认") {
			text = `范围：${identity.private ? "本人私聊" : "当前群聊"}\n将清除 ${Object.keys(details).length} 项专属人设细节，沿用当前人格模板。人格选择和群人设补充不变。\n确认：/人设 恢复默认 确认`;
			actions = [{
				label: "确认清除细节",
				command: "/人设 恢复默认 确认"
			}, {
				label: "返回人设",
				command: "/人设"
			}];
		} else if (match) {
			const [, action, field, value] = match;
			if (!personaDetailFields.includes(field)) throw new Error("未知字段，请用 /人设 查看字段列表");
			actions = fieldActions(field, access.canEdit);
			if (!access.canEdit) throw new Error("当前没有修改权限，请用 /我的权限 查看权益。");
			if (action === "清空" && value) throw new Error("清空只接受字段名。例如：/人设 清空 姓名");
			if (action === "编辑" && !value?.trim()) text = `编辑「${field}」 · ${identity.private ? "本人私聊" : "当前群聊"}\n当前：${details[field] || "未单独设置，沿用模板"}\n在下列指令后填写新内容，发送后替换本字段；最多 1200 字符。\n/人设 编辑 ${field} 新内容`;
			else {
				if (action === "清空") Reflect.deleteProperty(details, field);
				else details[field] = value;
				await saveScopedPersona(config, identity, details, expected);
				text = `${identity.private ? "本人私聊" : "当前群聊"} · 「${field}」已${action === "编辑" ? "保存" : "清空"}\n${action === "编辑" ? `当前：${details[field]}` : "后续沿用人格模板中的此项设置。"}\n下一轮对话生效。`;
			}
		} else {
			const field = args.startsWith("查看 ") ? args.slice(3).trim() : "";
			if (field && personaDetailFields.includes(field)) {
				actions = fieldActions(field, access.canEdit).filter((action) => action.label !== "查看字段");
				text = `${identity.private ? "本人私聊" : "当前群聊"} · ${field}${access.entitled ? "" : "（权益未启用，保存内容暂不生效）"}\n${details[field] || "未单独设置，沿用模板"}`;
			} else {
				if (args && !["查看", "列表"].includes(args) && !/^\d+$/u.test(args)) throw new Error("没有识别出这次操作。请返回人设，找到要调整的字段，再点击编辑。");
				const pages = Math.ceil(personaDetailFields.length / 4);
				const page = Math.min(pages, Math.max(1, Number(args) || 1));
				const sections = personaDetailFields.slice((page - 1) * 4, page * 4).map((field) => ({
					title: field,
					text: details[field] ? Array.from(details[field]).slice(0, 90).join("") + (Array.from(details[field]).length > 90 ? "…" : "") : "沿用默认模板",
					actions: [...details[field] ? [{
						label: "详情",
						command: `/人设 查看 ${field}`
					}] : [], ...access.canEdit ? [{
						label: "编辑",
						command: `/人设 编辑 ${field} `
					}, ...details[field] ? [{
						label: "清空",
						command: `/人设 清空 ${field}`
					}] : []] : []]
				}));
				await message.send({ format: sectionBubble("专属人设", `${identity.private ? "本人私聊" : "当前群聊"} · 第 ${page}/${pages} 页${access.entitled ? "" : " · 权益未启用，已保存内容暂不生效"}`, sections, {
					platform: event.Platform,
					actions: [
						...page > 1 ? [{
							label: "上一页",
							command: `/人设 ${page - 1}`
						}] : [],
						...page < pages ? [{
							label: "下一页",
							command: `/人设 ${page + 1}`
						}] : [],
						...access.canEdit ? [{
							label: "恢复默认",
							command: "/人设 恢复默认"
						}] : [],
						{
							label: "我的权限",
							command: "/我的权限"
						}
					]
				}) });
				return;
			}
		}
	} catch (error) {
		text = error instanceof Error ? error.message : "操作失败";
	}
	const chars = Array.from(text);
	const limit = Math.max(1, Math.min(900, config.maxMessageLength));
	for (let offset = 0; offset < chars.length; offset += limit) await message.send({ format: commandBubble(chars.slice(offset, offset + limit).join(""), "专属人设", {
		platform: event.Platform,
		actions: offset + limit >= chars.length ? actions : []
	}) });
};

export { res_default as default };