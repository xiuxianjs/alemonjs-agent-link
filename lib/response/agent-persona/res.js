import { getDSHConfig } from "../../dsh/runtime-config.js";
import { personaModes } from "../../companion/persona-modes.js";
import { getPersonaStore, validPersonaId } from "../../companion/personas.js";
import { resolveIntelligenceAccess } from "../../agent/intelligence.js";
import "../../dsh/client.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble, sectionBubble, supportsBubbles } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-persona/res.ts
const templateConfirmations = /* @__PURE__ */ new Map();
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	let limit = 900;
	const reply = async (text, actions = []) => {
		const chars = Array.from(text);
		const chunks = [];
		for (let i = 0; i < chars.length; i += limit) chunks.push(chars.slice(i, i + limit).join(""));
		for (const [index, chunk] of chunks.entries()) assertMessageDelivered(await message.send({ format: commandBubble(chunk, "人格", {
			platform: event.Platform,
			actions: index === chunks.length - 1 ? actions : []
		}) }));
	};
	try {
		const config = getDSHConfig();
		limit = Math.min(900, config.maxMessageLength);
		if (event.IsPrivate && !await canPrivateChatWithKey(event, config.privateChatAccess)) {
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
		const access = await resolveIntelligenceAccess({
			platform: event.Platform,
			channelId,
			userId: event.UserId || "",
			owner: Boolean(event.IsMaster),
			private: Boolean(event.IsPrivate),
			admin: !event.IsPrivate && await verifyGroupKeyAdmin(event)
		}, config);
		if (/^(?:程度|全局程度)(?:\s|$)/u.test(args)) {
			const [action, value, ...rest] = args.split(/\s+/u);
			const global = action === "全局程度";
			if (!value) {
				const labels = {
					活跃: "更爱接话和互动",
					个性: "更突出人物性格",
					工作: "直接说重点",
					专业: "严谨、克制地回答"
				};
				await message.send({ format: sectionBubble("说话方式", `${global ? "全局默认" : "当前会话"}：${store.expressionMode(global ? void 0 : scope)}。只改变表达风格，不改变智能程度。`, personaModes.map((mode) => ({
					title: mode,
					text: labels[mode],
					actions: event.IsMaster && (!global || event.IsPrivate) ? [{
						label: "选这个",
						command: `/人格 ${action} ${mode}`
					}] : []
				})), {
					platform: event.Platform,
					actions: [{
						label: "返回",
						command: "/人格 帮助"
					}, ...event.IsMaster && (!global || event.IsPrivate) ? [{
						label: "恢复默认",
						command: `/人格 ${action} 默认`
					}] : []]
				}) });
				return;
			}
			if (!event.IsMaster || global && !event.IsPrivate) {
				await reply(global ? "全局程度只能由主人在私聊修改。" : "只有机器人主人能修改当前会话的表达程度。");
				return;
			}
			if (rest.length || !personaModes.includes(value) && value !== "默认") {
				await reply("可选程度：活跃、个性、工作、专业；“默认”用于恢复继承。");
				return;
			}
			store.setExpressionMode(global ? void 0 : scope, value === "默认" ? void 0 : value, true);
			await reply(`${global ? "全局默认" : "当前会话"}程度已设为${store.expressionMode(global ? void 0 : scope)}，下一轮生效。${global ? "已单独设置的会话保留原值。" : ""}`);
			return;
		}
		if (args === "帮助") {
			await message.send({ format: sectionBubble("怎么调整人格", `${event.IsPrivate ? "这里调整你与机器人的私聊。" : "这里调整本群的机器人，群内成员都会受到影响。"}\n${supportsBubbles(event.Platform) ? "点击对应入口，再发送指令。" : "复制对应指令发送，即可打开设置。"}`, [
				{
					title: "换一种性格",
					text: access.canEdit ? "选一个喜欢的人格。切换会开始新话题。" : "可以浏览现有人格；当前身份不能切换。",
					actions: [{
						label: access.canEdit ? "挑选人格" : "查看人格",
						command: "/人格"
					}]
				},
				{
					title: "改称呼和习惯",
					text: access.canEdit ? "修改姓名、语气、爱好等细节，不影响其他会话。" : event.IsPrivate ? "绑定自己的 Key 后，就能修改姓名、语气和爱好。" : "本群启用 Key 权益后，由群管理员修改姓名、语气和爱好。",
					actions: [{
						label: access.canEdit ? "修改细节" : "查看细节",
						command: "/人设"
					}]
				},
				...event.IsMaster ? [{
					title: "调整说话方式",
					text: "想更活跃，还是更直接？按用途选择，不改变智能程度。",
					actions: [{
						label: "本会话",
						command: "/人格 程度"
					}, ...event.IsPrivate ? [{
						label: "全局默认",
						command: "/人格 全局程度"
					}] : []]
				}] : [],
				...event.IsMaster && event.IsPrivate ? [{
					title: "管理共享模板",
					text: "查看、追加设定或删除模板。这里的改动会影响使用该模板的会话。",
					actions: [{
						label: "管理模板",
						command: "/人格 管理"
					}]
				}] : []
			], {
				platform: event.Platform,
				actions: [{
					label: "智能程度",
					command: "/智能程度"
				}, {
					label: "我的权限",
					command: "/我的权限"
				}]
			}) });
			return;
		}
		if (/^管理(?:\s+\d+)?$/u.test(args)) {
			if (!event.IsMaster || !event.IsPrivate) {
				await reply("共享模板仅机器人主人可在私聊管理。", [{
					label: "返回帮助",
					command: "/人格 帮助"
				}]);
				return;
			}
			const rows = await store.list();
			await message.send({ format: sectionBubble("共享人格模板", "修改模板会影响使用它的会话；只改当前会话请用「人设细节」。", rows.map((row) => ({
				title: row.name,
				text: row.error ? "文件无效，请检查配置" : `编号：${row.id}`,
				actions: row.error ? [] : [
					{
						label: "查看设定",
						command: `/人格 查看 ${row.id}`
					},
					{
						label: "补充设定",
						command: `/人格 追加 ${row.id}`
					},
					{
						label: "查看补充",
						command: `/人格 查看追加 ${row.id}`
					}
				]
			})), {
				platform: event.Platform,
				page: {
					current: Number(args.split(/\s+/u)[1]) || 1,
					size: 4,
					command: "/人格 管理"
				},
				actions: [{
					label: "人设细节",
					command: "/人设"
				}, {
					label: "返回帮助",
					command: "/人格 帮助"
				}]
			}) });
			return;
		}
		if (!args || args === "列表" || /^\d+$/u.test(args)) {
			const selected = store.selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona || "配置默认";
			const rows = await store.list();
			const canSwitch = access.canEdit;
			const pages = Math.max(1, Math.ceil(rows.length / 6));
			const page = Math.min(pages, Math.max(1, Number(args) || 1));
			const sections = rows.slice((page - 1) * 6, page * 6).map((row) => ({
				title: `${row.name}（${row.id}）${row.id === selected ? " · 当前" : ""}`,
				text: row.error ? "文件无效" : "",
				actions: canSwitch && !row.error && row.id !== selected ? [{
					label: "使用",
					command: `/人格 使用 ${row.id}`
				}] : []
			}));
			const more = [...canSwitch ? [{
				label: "默认",
				command: "/人格 使用 默认"
			}] : [], {
				label: "人格帮助",
				command: "/人格 帮助"
			}];
			more.unshift(...page > 1 ? [{
				label: "上一页",
				command: `/人格 ${page - 1}`
			}] : [], ...page < pages ? [{
				label: "下一页",
				command: `/人格 ${page + 1}`
			}] : []);
			assertMessageDelivered(await message.send({ format: sectionBubble("人格", `${store.expressionMode(scope)} · 第 ${page}/${pages} 页；切换会开始新话题。`, sections, {
				platform: event.Platform,
				actions: more
			}) }));
			return;
		}
		const match = args.match(/^(使用|查看|保存|删除|追加|查看追加|清空追加)\s+([a-z][a-z0-9-]{0,63}|默认)(?:\s+([\s\S]+))?$/u);
		if (!match || match[2] !== "默认" && !validPersonaId(match[2])) {
			await reply("没有识别出这项操作。想换性格，请从列表中选择；其他调整可查看人格帮助。", [{
				label: "查看人格",
				command: "/人格"
			}, {
				label: "人格帮助",
				command: "/人格 帮助"
			}]);
			return;
		}
		const [, action, id] = match;
		let body = match[3];
		if (action === "使用") {
			if (!access.canEdit) {
				await reply(event.IsPrivate ? "绑定自己的 Key 后可以切换人格。" : "切换本群人格需要机器人主人，或本群启用 Key 权益后的群管理员。", [{
					label: "我的权限",
					command: "/我的权限"
				}, {
					label: "返回列表",
					command: "/人格"
				}]);
				return;
			}
			if (body) {
				await reply("一次只能选择一个人格。请在列表中点击想使用的人格。", [{
					label: "返回列表",
					command: "/人格"
				}]);
				return;
			}
			if (id !== "默认") await store.read(id);
			await resetGroupSession(channelId, config, () => store.select(scope, id === "默认" ? void 0 : id));
			await reply("好，接下来就按这个人设聊。当前会话也已经切到新话题了。", [{
				label: "查看当前人格",
				command: "/人格"
			}]);
			return;
		}
		if ([
			"追加",
			"查看追加",
			"清空追加"
		].includes(action) && !(event.IsMaster && event.IsPrivate)) {
			await reply("补充共享模板仅机器人主人可在私聊操作。只想调整当前会话的称呼、语气和习惯，请进入人设细节。", [{
				label: "人设细节",
				command: "/人设"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]);
			return;
		}
		if (!event.IsMaster || !event.IsPrivate) {
			await reply("共享人格模板仅机器人主人可在私聊管理。调整当前会话请进入人设细节。", [{
				label: "人设细节",
				command: "/人设"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]);
			return;
		}
		if (id === "默认") {
			await reply("请先选择一个具体模板，再进行管理。", [{
				label: "选择模板",
				command: "/人格 管理"
			}]);
			return;
		}
		if (["删除", "清空追加"].includes(action) && (!body || ["确认", "取消"].includes(body))) {
			if (action === "删除" && body !== "取消" && config.modules?.settings?.persona?.defaultId === id) {
				await reply("这个模板仍被配置为默认人格。请先修改服务端配置中的 persona.defaultId，再删除。", [{
					label: "返回模板",
					command: "/人格 管理"
				}]);
				return;
			}
			const key = JSON.stringify([
				config.workspaceRoot,
				event.Platform,
				event.BotId || "",
				channelId,
				event.UserId,
				action,
				id
			]);
			for (const [key, entry] of templateConfirmations) if (entry.expires <= Date.now()) templateConfirmations.delete(key);
			if (body === "取消") {
				templateConfirmations.delete(key);
				await reply("已取消，模板和补充设定未修改。", [{
					label: "返回模板",
					command: "/人格 管理"
				}]);
				return;
			}
			const persona = await store.read(id);
			const snapshot = JSON.stringify([persona, store.additions(id)]);
			if (!body) {
				if (templateConfirmations.size >= 1e3) {
					await reply("待确认操作过多，请稍后重试。", [{
						label: "返回模板",
						command: "/人格 管理"
					}]);
					return;
				}
				templateConfirmations.set(key, {
					expires: Date.now() + 6e4,
					snapshot
				});
				await reply(action === "删除" ? `删除共享模板「${persona.name}」\n使用它的会话将恢复默认，并开始新话题；该模板的补充设定也会清除。内置模板的自定义文件删除后，会恢复内置原设定。\n请本人在60秒内确认。` : `清空「${persona.name}」的补充设定\n使用这个共享模板的所有会话都会受影响，下一轮生效。基础模板保留。\n请本人在60秒内确认。`, [{
					label: action === "删除" ? "确认删除模板" : "确认清空补充",
					command: `/人格 ${action} ${id} 确认`
				}, {
					label: "取消操作",
					command: `/人格 ${action} ${id} 取消`
				}]);
				return;
			}
			const pending = templateConfirmations.get(key);
			templateConfirmations.delete(key);
			if (pending?.snapshot !== snapshot) {
				await reply("确认已失效或模板内容已变化。请重新查看影响范围，再决定是否执行。", [{
					label: "重新查看范围",
					command: `/人格 ${action} ${id}`
				}, {
					label: "返回模板",
					command: "/人格 管理"
				}]);
				return;
			}
			body = void 0;
		}
		if (action === "追加" && !body) await reply(`给「${(await store.read(id)).name}」补充设定\n在指令后写一句希望增加的性格或习惯，会影响使用这个模板的会话。\n例如：/人格 追加 ${id} 回答时先说结论`, [{
			label: "填写补充",
			command: `/人格 追加 ${id} `
		}, {
			label: "返回模板",
			command: "/人格 管理"
		}]);
		else if (action === "追加" && body) {
			await store.read(id);
			if (store.additions(id).length + body.trim().length + 1 > 4e3) {
				await reply("补充设定累计最多 4000 字符。请先查看已有补充，再决定是否清空。", [{
					label: "查看补充",
					command: `/人格 查看追加 ${id}`
				}]);
				return;
			}
			store.append(id, body);
			await reply(`已追加到 ${id}，使用该人格的会话下一轮生效。`, [{
				label: "查看补充",
				command: `/人格 查看追加 ${id}`
			}]);
		} else if (action === "查看追加" && !body) {
			await store.read(id);
			const additions = store.additions(id);
			await reply(additions || "这个人格还没有补充设定。", [
				{
					label: "补充设定",
					command: `/人格 追加 ${id}`
				},
				...additions ? [{
					label: "清空补充",
					command: `/人格 清空追加 ${id}`
				}] : [],
				{
					label: "返回模板",
					command: "/人格 管理"
				}
			]);
		} else if (action === "清空追加" && !body) {
			await store.read(id);
			store.clearAdditions(id);
			await reply("追加设定已清空，原人设保留；下一轮生效。", [{
				label: "返回模板",
				command: "/人格 管理"
			}]);
		} else if (action === "查看" && !body) {
			const persona = await store.read(id);
			await reply(`${persona.name}\n${persona.prompt}`, [
				{
					label: "编辑模板",
					command: `/人格 保存 ${id}`
				},
				{
					label: "删除模板",
					command: `/人格 删除 ${id}`
				},
				{
					label: "补充设定",
					command: `/人格 追加 ${id}`
				},
				{
					label: "查看补充",
					command: `/人格 查看追加 ${id}`
				},
				{
					label: "返回模板",
					command: "/人格 管理"
				}
			]);
		} else if (action === "保存" && (!body || !body.includes("|") || !body.slice(0, body.indexOf("|")).trim() || !body.slice(body.indexOf("|") + 1).trim())) await reply(`编辑共享模板「${id}」\n请填写模板名称和完整设定，中间用 | 分开。保存会替换这个模板的原设定，使用它的会话都会受到影响。\n例如：/人格 保存 ${id} 小鱼|回答简洁，先说结论\n只改称呼和习惯，可以进入人设细节。`, [
			{
				label: "填写模板",
				command: `/人格 保存 ${id} `
			},
			{
				label: "人设细节",
				command: "/人设"
			},
			{
				label: "返回模板",
				command: "/人格 管理"
			}
		]);
		else if (action === "保存" && body?.includes("|")) {
			const split = body.indexOf("|");
			const existing = (await store.list()).some((row) => row.id === id) ? await store.read(id) : void 0;
			await store.save({
				...existing,
				id,
				name: body.slice(0, split).trim(),
				prompt: body.slice(split + 1).trim()
			});
			await reply(`共享模板「${body.slice(0, split).trim()}」已保存，使用它的会话下一轮生效。`, [{
				label: "查看设定",
				command: `/人格 查看 ${id}`
			}, {
				label: "返回模板",
				command: "/人格 管理"
			}]);
		} else if (action === "删除" && !body) {
			if (config.modules?.settings?.persona?.defaultId === id) {
				await reply("这个模板仍被配置为默认人格。请先修改服务端配置中的 persona.defaultId，再删除。", [{
					label: "返回模板",
					command: "/人格 管理"
				}]);
				return;
			}
			for (const selected of store.scopesUsing(id)) await resetGroupSession(selected.channelId, config, () => store.select(selected));
			await store.remove(id);
			await reply("人格文件已删除，相关会话恢复默认；内置人格恢复原设定。", [{
				label: "返回模板",
				command: "/人格 管理"
			}]);
		} else await reply("这项操作不需要附加内容。请先查看模板，再选择对应操作。", [{
			label: "查看模板",
			command: `/人格 查看 ${id}`
		}, {
			label: "返回模板",
			command: "/人格 管理"
		}]);
	} catch {
		await reply("这次操作未能确认完成。请先查看当前人格或模板列表，核对结果后再重试。", [
			{
				label: "当前人格",
				command: "/人格"
			},
			...event.IsMaster && event.IsPrivate ? [{
				label: "模板列表",
				command: "/人格 管理"
			}] : [],
			{
				label: "人格帮助",
				command: "/人格 帮助"
			}
		]);
	}
};

export { res_default as default };