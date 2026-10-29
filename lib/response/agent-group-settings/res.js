import { boundKeyGroupPolicy } from "../../social/group-policy.js";
import { getPersonaStore } from "../../companion/personas.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { activityCeiling, getGroupSettingsStore, groupPolicy, groupVoicePolicy, normalizeGroupSetting } from "../../social/group-settings.js";
import { isKeyEntitledGroup } from "../../social/groups.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-group-settings/res.ts
const activityLabels = {
	quiet: "安静",
	balanced: "正常",
	active: "活跃"
};
const fieldLabels = {
	activity: "强度",
	quietHours: "静默",
	maxPerHour: "每小时上限",
	interests: "兴趣词",
	wakeNames: "补充唤醒词",
	bannedWords: "禁语词",
	voiceEnabled: "语音",
	voiceAuto: "自动语音",
	reset: "重置"
};
/** 口语化的强度说法，直接当成设置项。 */
const activityAliases = {
	安静: "quiet",
	安静点: "quiet",
	安静一点: "quiet",
	小声点: "quiet",
	少说点: "quiet",
	正常: "balanced",
	正常点: "balanced",
	默认: "balanced",
	活跃: "active",
	活跃点: "active",
	活跃一点: "active",
	积极点: "active",
	多说点: "active"
};
const helpFor = {
	activity: "三选一：\n/群设置 安静 — 只在被叫时说话\n/群设置 正常 — 偶尔接一句（默认）\n/群设置 活跃 — 更主动接话",
	quietHours: "安静时段只影响主动参与，被叫仍会回。\n/群设置 静默 1-8 — 凌晨 1 点到早 8 点\n/群设置 静默 关闭 — 取消\n/群设置 静默 默认 — 恢复配置",
	maxPerHour: "只能往下调，当前档位有上限。\n/群设置 每小时 4 — 每小时最多主动插话 4 次\n/群设置 每小时 默认 — 恢复档位默认",
	interests: "只影响普通模式的话题相关度。\n/群设置 兴趣 吃饭,游戏,猫 — 整组替换\n/群设置 兴趣 清空 — 回落到配置",
	wakeNames: "群里说到这些词也会当成在叫它。\n/群设置 唤醒词 加 小鱼\n/群设置 唤醒词 删 小鱼\n/群设置 唤醒词 查看\n/群设置 唤醒词 清空",
	bannedWords: "只过滤它自己的输出，等长遮盖。\n/群设置 禁语 加 某词\n/群设置 禁语 删 某词\n/群设置 禁语 查看\n/群设置 禁语 清空",
	voiceEnabled: "/群设置 语音 关闭 — 本群一律用文字\n/群设置 语音 开启 — 恢复使用语音",
	voiceAuto: "/群设置 语音 自动关闭 — 只在明确要求时语音\n/群设置 语音 自动开启 — 恢复自动语音"
};
const helpSections = [
	{
		title: "说话频率",
		text: "三选一；活跃更主动，安静只在被叫时说话；上限只能调低。",
		actions: [
			{
				label: "安静",
				command: "/群设置 安静"
			},
			{
				label: "正常",
				command: "/群设置 正常"
			},
			{
				label: "活跃",
				command: "/群设置 活跃"
			}
		]
	},
	{
		title: "免打扰",
		text: "只影响主动参与，被叫仍会回。",
		actions: [{
			label: "1–8 点静默",
			command: "/群设置 静默 1-8"
		}, {
			label: "取消静默",
			command: "/群设置 静默 关闭"
		}]
	},
	{
		title: "唤醒词 / 禁语",
		text: "唤醒词是叫它的词；禁语只过滤它自己的话。",
		actions: [{
			label: "查看唤醒词",
			command: "/群设置 唤醒词 查看"
		}, {
			label: "查看禁语",
			command: "/群设置 禁语 查看"
		}]
	},
	{
		title: "语音",
		text: "本群可关闭语音，或只保留明确 /语音。",
		actions: [{
			label: "语音设置",
			command: "/群设置 语音 查看"
		}]
	},
	{
		title: "人设与记录",
		text: "人设可写一句称呼或口癖；改错可恢复默认，所有改动都有记录。",
		actions: [
			{
				label: "看人设",
				command: "/群设置 人设 查看"
			},
			{
				label: "清空人设",
				command: "/群设置 人设 清空"
			},
			{
				label: "调整记录",
				command: "/群设置 记录"
			},
			{
				label: "恢复默认",
				command: "/群设置 重置"
			},
			{
				label: "返回设置",
				command: "/群设置 查看"
			}
		]
	}
];
const show = (value) => {
	if (value === void 0 || value === null) return "未设置";
	if (Array.isArray(value)) return value.length === 2 && value.every((item) => typeof item === "number") ? `${value[0]}–${value[1]} 点` : value.join("、") || "无";
	if (typeof value === "object") return `${value[0]}–${value[1]} 点`;
	return String(value);
};
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const [message] = useMessage();
	const [route] = useRoute();
	let limit = 900;
	const reply = async (text, actions = []) => {
		const chars = Array.from(text);
		for (let offset = 0; offset < chars.length; offset += limit) {
			const chunk = chars.slice(offset, offset + limit).join("");
			const last = offset + limit >= chars.length;
			await message.send({ format: commandBubble(chunk, "本群设置", {
				platform: event.Platform,
				actions: last ? actions : []
			}) });
		}
	};
	if (event.IsPrivate || !event.ChannelId) {
		await reply("群设置要在想调整的群里发，比如 @我 之后输入 /群设置。", []);
		return;
	}
	try {
		const config = getDSHConfig();
		const platform = event.Platform || "";
		const channelId = event.ChannelId;
		const store = getGroupSettingsStore(config);
		const settings = store.get(platform, channelId);
		const policy = groupPolicy(config, channelId, platform);
		const args = route.rawArgs.map(String).filter(Boolean);
		const action = args[0] || "查看";
		const canEdit = event.IsMaster === true || await verifyGroupKeyAdmin(event);
		const requireEdit = async () => {
			if (canEdit) return true;
			await reply("只有群管理员或机器人主人能改。设置可以看，改法可以问，但不会保存。", [{
				label: "指令说明",
				command: "/群设置 帮助"
			}]);
			return false;
		};
		limit = Math.min(900, config.maxMessageLength);
		if (action === "查看" || action === "状态" || action === "菜单") {
			const entitled = await isKeyEntitledGroup({
				platform,
				channelId
			}).catch(() => false);
			const voice = groupVoicePolicy(config, channelId, platform);
			const effective = entitled ? boundKeyGroupPolicy(policy) : policy;
			const activity = effective.activity;
			const quiet = effective.quietHours;
			const quietText = quiet[0] === quiet[1] ? "关闭" : `${quiet[0]}–${quiet[1]} 点`;
			const maxPerHour = effective.maxPerHour;
			const wake = settings.wakeNames?.length ? settings.wakeNames.join("、") : "无";
			const banned = settings.bannedWords?.length ? settings.bannedWords.join("、") : "无";
			const interests = effective.interests.length ? effective.interests.join("、") : "无";
			const personaAddition = getPersonaStore(config).scopeAdditions({
				platform,
				channelId
			});
			const personaText = personaAddition ? `已设置 ${Array.from(personaAddition).length} 字` : "未设置";
			const sections = [
				{
					title: "说话频率",
					text: `当前：${activityLabels[activity] || activity}；每小时主动插话上限 ${maxPerHour} 次${entitled ? "；群钥匙权益已生效" : ""}`,
					actions: canEdit ? [
						{
							label: "安静",
							command: "/群设置 安静"
						},
						{
							label: "正常",
							command: "/群设置 正常"
						},
						{
							label: "活跃",
							command: "/群设置 活跃"
						}
					] : []
				},
				{
					title: "免打扰",
					text: `静默：${quietText}；被叫仍会回`,
					actions: canEdit ? [{
						label: "1–8 点",
						command: "/群设置 静默 1-8"
					}, {
						label: "取消",
						command: "/群设置 静默 关闭"
					}] : []
				},
				{
					title: "唤醒词 / 禁语",
					text: `唤醒词：${wake} · 禁语：${banned}`,
					actions: [{
						label: "查看唤醒词",
						command: "/群设置 唤醒词 查看"
					}, {
						label: "查看禁语",
						command: "/群设置 禁语 查看"
					}]
				},
				{
					title: "语音与其他",
					text: `语音：${voice.allowed ? `已允许（自动语音${voice.auto ? "开" : "关"}）` : "已关闭"}\n人设：${personaText} · 兴趣：${interests}${entitled ? "；本群钥匙权益已生效" : ""}`,
					actions: [
						{
							label: "语音设置",
							command: "/群设置 语音 查看"
						},
						{
							label: "人设",
							command: "/群设置 人设 查看"
						},
						{
							label: "指令说明",
							command: "/群设置 帮助"
						}
					]
				}
			];
			await message.send({ format: sectionBubble("本群设置", canEdit ? "谁都能看，管理员能改。点对应项旁边的按钮。" : "谁都能看；只有群管理员或机器人主人能改。", sections, {
				platform: event.Platform,
				layout: "inline"
			}) });
			return;
		}
		if (action === "帮助" || action === "说明" || action === "指令") {
			await message.send({ format: sectionBubble("本群设置 · 指令说明", "常用操作；完整说明见 /帮助 群设置。", helpSections, {
				platform: event.Platform,
				layout: "inline"
			}) });
			return;
		}
		if (action === "记录") {
			const rows = store.audit(platform, channelId, 10);
			await reply(rows.length ? ["最近调整", ...rows.map((row) => `${new Date(row.at).toLocaleString("zh-CN", {
				timeZone: policy.timezone,
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			})} ${row.operator || "未知"}：${fieldLabels[row.field] || row.field}${row.before ? ` ${row.before} →` : ""} ${row.after || "清除"}`)].join("\n") : "本群还没有调整记录。", [{
				label: "返回设置",
				command: "/群设置 查看"
			}]);
			return;
		}
		if (action === "重置") {
			if (!await requireEdit()) return;
			store.reset(platform, channelId, event.UserId || "admin");
			await reply("已恢复群设置默认值；人设补充和钥匙授权保持原状。下一条消息生效。", [{
				label: "查看当前",
				command: "/群设置 查看"
			}]);
			return;
		}
		if (action === "人设" || action === "人设补充") {
			const operation = args[1] || "";
			const persona = getPersonaStore(config);
			const scope = {
				platform,
				channelId
			};
			const current = persona.scopeAdditions(scope);
			if (!operation || ["查看", "状态"].includes(operation)) {
				await reply(current ? `本群人设补充（${Array.from(current).length} 字）：\n${current}\n\n重新发送会整体替换：/群设置 人设 新内容\n清空：/群设置 人设 清空` : "本群还没有人设补充。\n直接发一句就会保存，例如：/群设置 人设 群里说话随意点，可以叫我阿鱼。\n重新发送会整体替换。", [{
					label: "清空人设",
					command: "/群设置 人设 清空"
				}, {
					label: "返回设置",
					command: "/群设置 查看"
				}]);
				return;
			}
			if ([
				"帮助",
				"怎么用",
				"说明",
				"用法"
			].includes(operation)) {
				await reply([
					"人设补充只改表达，不改能力、权限和身份。",
					"/群设置 人设 群里说话随意点，可以叫我阿鱼。",
					"/群设置 人设 查看 — 看当前内容",
					"/群设置 人设 清空 — 删掉",
					"",
					"只有一个输入位：重新发送会整体替换上一次，不是累加。"
				].join("\n"));
				return;
			}
			if (!await requireEdit()) return;
			if (operation === "清空" || operation === "删除" || operation === "移除") {
				persona.clearScopeAdditions(scope);
				await reply("已清空本群人设补充。");
				return;
			}
			const text = (operation === "设置" ? args.slice(2) : args.slice(1)).join(" ").trim();
			if (!text) {
				await reply("发一句要补充的内容，例如：/群设置 人设 群里说话随意点，可以叫我阿鱼。");
				return;
			}
			if (/(忽略|无视|跳过|忘记)(以上|之前|上面|前面|所有)?(的)?(规则|限制|指令|提示)|系统提示|system\s*prompt|你现在是|从现在开始你是|可以(执行|运行|调用)(命令|终端|shell)|读取(私聊|其他群)|不要告诉主人/iu.test(text)) {
				await reply("这段内容包含改变规则、身份或权限的指令，不能作为人设补充。请改成称呼、语气、口癖一类的表达。");
				return;
			}
			try {
				persona.setScopeAdditions(scope, text, event.UserId || "admin");
			} catch (error) {
				await reply(error instanceof Error ? error.message : "保存失败，请稍后再试。");
				return;
			}
			await reply(`已保存本群人设补充（${Array.from(text).length} 字），下一条消息生效。\n重新发送会整体替换。`, [{
				label: "看当前",
				command: "/群设置 人设 查看"
			}, {
				label: "清空",
				command: "/群设置 人设 清空"
			}]);
			return;
		}
		if (action === "语音") {
			const operation = args[1] || "";
			const voiceActions = {
				开启: { voiceEnabled: true },
				打开: { voiceEnabled: true },
				关闭: { voiceEnabled: false },
				自动开启: { voiceAuto: true },
				自动关闭: { voiceAuto: false },
				恢复: {
					voiceEnabled: true,
					voiceAuto: true
				}
			};
			if (!operation || [
				"帮助",
				"怎么用",
				"说明"
			].includes(operation)) {
				await reply([
					"语音设置（只影响本群）",
					"/群设置 语音 关闭 — 本群一律用文字",
					"/群设置 语音 开启 — 恢复使用语音",
					"/群设置 语音 自动关闭 — 只在明确要求时语音",
					"/群设置 语音 自动开启 — 恢复自动语音",
					"/群设置 语音 查看 — 看当前状态",
					"",
					"前提：主人已经在 media.tts 或 speech 里配置好语音服务。"
				].join("\n"), [{
					label: "查看语音",
					command: "/群设置 语音 查看"
				}, {
					label: "返回设置",
					command: "/群设置 查看"
				}]);
				return;
			}
			if (operation === "查看") {
				await reply([
					`本群语音：${settings.voiceEnabled === false ? "已关闭（一律文字）" : "可用"}`,
					`自动语音：${settings.voiceAuto === false ? "已关闭（只回应 /语音）" : "跟随全局"}`,
					"改回来：/群设置 语音 恢复"
				].join("\n"), [
					{
						label: "关闭语音",
						command: "/群设置 语音 关闭"
					},
					{
						label: "自动关闭",
						command: "/群设置 语音 自动关闭"
					},
					{
						label: "全部恢复",
						command: "/群设置 语音 恢复"
					}
				]);
				return;
			}
			const patch = voiceActions[operation];
			if (!patch) {
				await reply("语音只有这几种：开启、关闭、自动开启、自动关闭、查看。", [{
					label: "语音设置",
					command: "/群设置 语音 查看"
				}]);
				return;
			}
			if (!await requireEdit()) return;
			const result = store.update(platform, channelId, event.UserId || "admin", patch);
			if (result.ok === false) {
				await reply(result.reason);
				return;
			}
			const done = [];
			if (patch.voiceEnabled === false) done.push("本群以后一律用文字，/语音 也只回文字。");
			if (patch.voiceEnabled === true) done.push("已恢复使用语音。");
			if (patch.voiceAuto === false) done.push("已关闭自动语音，只在明确要求时合成。");
			if (patch.voiceAuto === true) done.push("已恢复自动语音。");
			await reply(`${done.join("") || "已保存。"}\n下一条消息生效。`, [{
				label: "看看现在",
				command: "/群设置 语音 查看"
			}, {
				label: "全部恢复",
				command: "/群设置 语音 恢复"
			}]);
			return;
		}
		const oral = activityAliases[action];
		if (oral) {
			if (!await requireEdit()) return;
			const result = store.update(platform, channelId, event.UserId || "admin", { activity: oral });
			if (result.ok === false) {
				await reply(`${result.reason}\n也可以点按钮换一档。`);
				return;
			}
			await reply(`已保存${activityLabels[oral]}档位。主人配置优先，请通过 /群设置 查看 确认生效设置。`);
			return;
		}
		const field = {
			强度: "activity",
			静默: "quietHours",
			免打扰: "quietHours",
			每小时: "maxPerHour",
			每小时上限: "maxPerHour",
			兴趣: "interests",
			兴趣词: "interests",
			唤醒词: "wakeNames",
			唤醒: "wakeNames",
			禁语: "bannedWords",
			禁语词: "bannedWords"
		}[action];
		if (!field) {
			await reply([
				"没看懂这条。发 /群设置 帮助 可以看全部指令。",
				"常写的几条：",
				"/群设置 安静",
				"/群设置 静默 1-8",
				"/群设置 唤醒词 加 小鱼",
				"/群设置 禁语 加 某词"
			].join("\n"));
			return;
		}
		const operation = args[1] || "";
		if (!operation || [
			"帮助",
			"怎么用",
			"用法",
			"说明"
		].includes(operation)) {
			await reply(helpFor[field], [{
				label: "返回设置",
				command: "/群设置 查看"
			}]);
			return;
		}
		const listField = field === "wakeNames" || field === "bannedWords";
		const listName = field === "wakeNames" ? "唤醒词" : "禁语词";
		if (listField && operation === "查看") {
			const list = settings[field] || [];
			await reply(list.length ? `${listName}（${list.length}）：${list.join("、")}` : `${listName}：还没有。`, [{
				label: `清空${listName}`,
				command: `/群设置 ${action} 清空`
			}, {
				label: "返回设置",
				command: "/群设置 查看"
			}]);
			return;
		}
		let value;
		if (listField && (operation === "清空" || operation === "全部清空")) value = void 0;
		else if (listField && (operation === "删" || operation === "删除" || operation === "移除")) {
			const word = args.slice(2).join(" ").trim();
			const current = settings[field] || [];
			if (!word) {
				await reply(`要删哪个？例如 /群设置 ${action} 删 ${current[0] || "某个词"}`);
				return;
			}
			if (!current.includes(word)) {
				await reply(`${listName}里没有「${word}」。现在有：${current.length ? current.join("、") : "无"}`);
				return;
			}
			value = current.filter((item) => item !== word);
			if (!value.length) value = void 0;
		} else if (listField) {
			const text = (operation === "加" || operation === "添加" ? args.slice(2) : args.slice(1)).join(" ").trim();
			const parsed = normalizeGroupSetting(field, text);
			if (!parsed) {
				await reply(helpFor[field], [{
					label: "返回设置",
					command: "/群设置 查看"
				}]);
				return;
			}
			value = normalizeGroupSetting(field, [...settings[field] || [], ...Array.isArray(parsed) ? parsed : []]);
		} else if (field === "activity") value = normalizeGroupSetting(field, activityAliases[operation] || operation);
		else if (field === "maxPerHour" && (operation === "默认" || operation === "恢复")) value = void 0;
		else value = normalizeGroupSetting(field, args.slice(1).join(" "));
		if (field === "maxPerHour") {
			const ceiling = activityCeiling(policy.activity);
			if (typeof value === "number" && value > ceiling) {
				await reply(`每小时上限只能往下调，当前档位最多 ${ceiling} 次。\n想更活跃，先发 /群设置 活跃。`);
				return;
			}
		}
		const patch = {};
		patch[field] = value;
		if (!await requireEdit()) return;
		const result = store.update(platform, channelId, event.UserId || "admin", patch);
		if (result.ok === false) {
			await reply(result.reason);
			return;
		}
		await reply(`${{
			activity: `说话频率已改成「${activityLabels[String(value)] || show(value)}」。`,
			quietHours: value === void 0 ? "静默已恢复配置默认。" : Array.isArray(value) && value[0] === value[1] ? "已取消夜间静默。" : `已设置 ${show(value)} 不主动说话；被叫仍会回。`,
			maxPerHour: value === void 0 ? "已恢复当前档位的默认上限。" : `每小时主动插话上限已保存为 ${show(value)} 次。`,
			interests: `兴趣词已更新：${show(value) || "无"}。`,
			wakeNames: value === void 0 ? "已清空本群补充的唤醒词。" : `好，以后群里说到「${show(value)}」也会找我。`,
			bannedWords: value === void 0 ? "已清空本群禁语词。" : `好，本群不会再说「${show(value)}」这个词。`
		}[field] || "已保存。"}\n主人配置优先，群钥匙权益可能调整参与上限，请查看当前生效设置。`, [{
			label: "看看现在",
			command: "/群设置 查看"
		}, {
			label: "指令说明",
			command: "/群设置 帮助"
		}]);
	} catch (error) {
		await reply(`${error instanceof Error ? error.message : "设置暂时保存不了，请稍后再试。"}\n发 /群设置 帮助 看全部指令。`);
	}
};

export { res_default as default };