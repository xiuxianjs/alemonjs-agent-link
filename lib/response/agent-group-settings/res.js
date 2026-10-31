import { newsCandidate } from "../../group-topics/news.js";
import { getGroupTopicStore, groupTopicId } from "../../group-topics/store.js";
import { boundKeyGroupPolicy } from "../../social/group-policy.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { collectGroupVideoTopics } from "../../group-topics/collect.js";
import { getPersonaStore } from "../../companion/personas.js";
import { activityCeiling, getGroupSettingsStore, groupPolicy, groupVoicePolicy, normalizeGroupSetting } from "../../social/group-settings.js";
import { resolveIntelligenceAccess } from "../../agent/intelligence.js";
import "../../dsh/client.js";
import { isKeyEntitledGroup } from "../../social/groups.js";
import { verifyGroupKeyAdmin } from "../../credentials/group-admin.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-group-settings/res.ts
const resetConfirmations = /* @__PURE__ */ new Map();
const personaClearConfirmations = /* @__PURE__ */ new Map();
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
	const reply = async (text, actions = [{
		label: "返回设置",
		command: "/群设置 查看"
	}]) => {
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
		await reply("请到需要调整的目标群使用 /群设置；设置只影响那个群。", [{
			label: "我的权限",
			command: "/我的权限"
		}, {
			label: "聊天说明",
			command: "/帮助 聊天"
		}]);
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
		const fixedAction = [
			"查看",
			"状态",
			"菜单",
			"帮助",
			"说明",
			"指令",
			"记录",
			"重置"
		].includes(action) || Boolean(activityAliases[action]);
		const fixedSubAction = action === "语音" || ["人设", "人设补充"].includes(action) && [
			"查看",
			"状态",
			"帮助",
			"怎么用",
			"说明",
			"用法",
			"清空",
			"删除",
			"移除"
		].includes(args[1]) || [
			"唤醒词",
			"唤醒",
			"禁语",
			"禁语词"
		].includes(action) && [
			"查看",
			"清空",
			"全部清空",
			"帮助",
			"怎么用",
			"说明",
			"用法"
		].includes(args[1]);
		const resetDecision = action === "重置" && args.length === 2 && ["确认", "取消"].includes(args[1]);
		const personaDecision = ["人设", "人设补充"].includes(action) && [
			"清空",
			"删除",
			"移除"
		].includes(args[1]) && args.length === 3 && ["确认", "取消"].includes(args[2]);
		const listPageDecision = [
			"唤醒词",
			"唤醒",
			"禁语",
			"禁语词"
		].includes(action) && args[1] === "查看" && args.length === 3 && /^[1-9]\d*$/u.test(args[2]) && Number.isSafeInteger(Number(args[2]));
		if (fixedAction && args.length > 1 && !resetDecision || fixedSubAction && args.length > 2 && !personaDecision && !listPageDecision || [
			"强度",
			"每小时",
			"每小时上限"
		].includes(action) && args.length > 2) {
			await reply("这项操作后有多余内容，尚未修改设置。请返回对应设置入口，再选择要执行的操作。");
			return;
		}
		const canEdit = event.IsMaster === true || await verifyGroupKeyAdmin(event);
		const requireEdit = async () => {
			if (canEdit) return true;
			await reply("只有群管理员或机器人主人能改。设置可以看，改法可以问，但不会保存。", [{
				label: "指令说明",
				command: "/群设置 帮助"
			}]);
			return false;
		};
		if (action === "话题") {
			if (!event.BotId) {
				await reply("缺少机器人身份，无法读取群话题档案。");
				return;
			}
			const topics = getGroupTopicStore(config);
			const id = groupTopicId(platform, event.BotId, channelId);
			const profile = topics.profile(id) || {
				id,
				platform,
				botId: event.BotId,
				channelId,
				positioning: "尚未设置",
				tags: [],
				blockedTags: [],
				enabled: false,
				shareOut: false,
				receiveShared: false
			};
			const sub = args[1] || "查看";
			const value = args.slice(2).join(" ").trim();
			const topicActions = [{
				label: "话题设置",
				command: "/群设置 话题 查看"
			}, {
				label: "返回群设置",
				command: "/群设置 查看"
			}];
			if (["查看", "帮助"].includes(sub) && value || sub === "候选" && value && (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value)))) {
				await reply("这项查看操作不需要附加内容。请返回话题设置选择入口。", topicActions);
				return;
			}
			if ([
				"定位",
				"标签",
				"禁忌"
			].includes(sub) && !value) {
				if (!await requireEdit()) return;
				await reply(sub === "定位" ? "填写一句本群用途，例如“修仙游戏交流群”。发送后替换本群定位。" : `填写本群${sub}，多个词用空格或逗号分隔；发送后整体替换，写“清空”移除。`, [{
					label: "填写内容",
					command: `/群设置 话题 ${sub} `
				}, ...topicActions]);
				return;
			}
			if (sub === "采集") {
				if (!await requireEdit()) return;
				if (value) {
					await reply("采集按本群标签检索，不需要附加内容。请返回话题设置重新选择。", topicActions);
					return;
				}
				await reply(`已按本群标签检索 B 站，新增 ${await collectGroupVideoTopics(config, id)} 条今日或昨日公开视频线索。仅有标题元数据，未核实观点；没有符合内容时不补造。不会自动发送。`, [{
					label: "查看候选",
					command: "/群设置 话题 候选"
				}, ...topicActions]);
				return;
			}
			if (sub === "候选详情") {
				if (!await requireEdit()) return;
				const selected = topics.candidates(id).find(({ topic }) => topic.id === value);
				if (!selected) {
					await reply("这个候选已过期、不再匹配本群，或编号无效。请查看当前候选。", [{
						label: "当前候选",
						command: "/群设置 话题 候选"
					}, ...topicActions]);
					return;
				}
				await reply(`${selected.topic.summary}\n来源：${selected.topic.origin === "human-discussion" ? "已授权匿名讨论" : selected.topic.sourceUrl}`, [{
					label: "返回候选",
					command: "/群设置 话题 候选"
				}, ...topicActions]);
				return;
			}
			if (sub === "候选") {
				if (!await requireEdit()) return;
				const candidates = topics.candidates(id);
				await message.send({ format: sectionBubble("本群话题候选", candidates.length ? `共 ${candidates.length} 条，按当前权限、标签和时效匹配；尚未接通自动发送。` : "暂无符合本群权限、标签与时效的候选；未开启冒泡的群不显示可发送候选。", candidates.map(({ topic, score }) => ({
					title: `匹配 ${Math.round(score * 100)}%`,
					text: `${Array.from(topic.summary).slice(0, 180).join("")}${Array.from(topic.summary).length > 180 ? "…" : ""}\n标签：${topic.tags.filter((tag) => profile.tags.includes(tag)).join("、")}\n来源：${topic.origin === "human-discussion" ? "已授权匿名讨论" : "公开来源"}`,
					actions: [{
						label: "查看全文",
						command: `/群设置 话题 候选详情 ${topic.id}`
					}, ...topic.origin !== "human-discussion" && topic.sourceUrl ? [{
						label: "查看来源",
						url: topic.sourceUrl
					}] : []]
				})), {
					platform: event.Platform,
					page: {
						current: Number(value) || 1,
						size: 3,
						command: "/群设置 话题 候选"
					},
					actions: topicActions
				}) });
				return;
			}
			if (sub === "新闻") {
				if (!await requireEdit()) return;
				if (!profile.enabled || !profile.tags.length) {
					await reply("请先配置群定位、标签并开启冒泡意愿。");
					return;
				}
				if (args.length < 6) {
					await reply("录入一条新闻候选\n按顺序填写：HTTPS 原文链接、发布日期（YYYY-MM-DD）、逗号分隔的标签、事实摘要。\n仅接受北京时间今天或昨天的新闻，摘要最多1200字。请先核实原文与日期；录入后进入公共候选池，不会立即发送。", [{
						label: "填写新闻",
						command: "/群设置 话题 新闻 "
					}, ...topicActions]);
					return;
				}
				const candidate = newsCandidate(args[2], args[3], args[4].split(/[,，]/u), args.slice(5).join(" "));
				await reply(topics.addTopic(candidate) ? "已录入公共新闻候选池。可用 /群设置 话题 候选 检查本群匹配；尚未接通自动发送。" : "该来源已在候选池中，未重复录入。", [{
					label: "查看候选",
					command: "/群设置 话题 候选"
				}, ...topicActions]);
				return;
			}
			if (sub !== "查看" && sub !== "帮助") {
				if (!await requireEdit()) return;
				if (sub === "定位" && value) profile.positioning = value;
				else if (sub === "标签" || sub === "禁忌") {
					if (!value) {
						await reply("请填写标签，以空格或逗号分隔；写“清空”移除。");
						return;
					}
					profile[sub === "标签" ? "tags" : "blockedTags"] = value === "清空" ? [] : value.split(/[,，\s]+/u);
				} else if ([
					"冒泡",
					"输出",
					"接收"
				].includes(sub) && ["开启", "关闭"].includes(value)) {
					const field = sub === "冒泡" ? "enabled" : sub === "输出" ? "shareOut" : "receiveShared";
					if (value === "开启" && (profile.positioning === "尚未设置" || !profile.tags.length)) {
						await reply("请先设置群定位和标签，再开启权限。");
						return;
					}
					profile[field] = value === "开启";
				} else {
					await reply("没有识别出话题操作。请返回话题设置，选择要修改的项目。", topicActions);
					return;
				}
				topics.saveProfile(profile);
			}
			await message.send({ format: sectionBubble("本群话题设置", "只影响当前群的档案与候选匹配；自动采集与发送尚未接入。", [
				{
					title: "群定位",
					text: profile.positioning,
					actions: canEdit ? [{
						label: "编辑定位",
						command: "/群设置 话题 定位 "
					}] : []
				},
				{
					title: "标签与禁忌",
					text: `标签：${profile.tags.join("、") || "未设置"}\n禁忌：${profile.blockedTags.join("、") || "未设置"}`,
					actions: canEdit ? [{
						label: "编辑标签",
						command: "/群设置 话题 标签 "
					}, {
						label: "编辑禁忌",
						command: "/群设置 话题 禁忌 "
					}] : []
				},
				...[
					["冒泡", profile.enabled],
					["输出", profile.shareOut],
					["接收", profile.receiveShared]
				].map(([label, enabled]) => ({
					title: `${label}意愿`,
					text: enabled ? "已开启；仍需符合候选权限和时效" : "已关闭",
					actions: canEdit ? [{
						label: enabled ? "关闭" : "开启",
						command: `/群设置 话题 ${label} ${enabled ? "关闭" : "开启"}`
					}] : []
				}))
			], {
				platform: event.Platform,
				actions: [...canEdit ? [{
					label: "查看候选",
					command: "/群设置 话题 候选"
				}, {
					label: "按标签采集",
					command: "/群设置 话题 采集"
				}] : [], ...topicActions]
			}) });
			return;
		}
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
							label: "群话题",
							command: "/群设置 话题 查看"
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
			const personaAccess = await resolveIntelligenceAccess({
				platform,
				channelId,
				userId: event.UserId || "",
				owner: Boolean(event.IsMaster),
				private: false,
				admin: canEdit
			}, config);
			const visibleHelp = helpSections.map((section) => ({
				...section,
				actions: section.actions.filter((item) => {
					if (item.command === "/群设置 人设 清空") return personaAccess.canEdit;
					return canEdit || /(?:查看|记录)$/u.test(item.command);
				})
			}));
			await message.send({ format: sectionBubble("本群设置 · 指令说明", "常用操作；修改须有对应权限。", visibleHelp, {
				platform: event.Platform,
				actions: [{
					label: "返回设置",
					command: "/群设置 查看"
				}]
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
			if (!platform || !event.UserId) {
				await reply("无法确认平台或操作者，请重新发送。");
				return;
			}
			const key = JSON.stringify([
				config.workspaceRoot,
				platform,
				event.BotId || "",
				channelId,
				event.UserId
			]);
			for (const [id, entry] of resetConfirmations) if (entry.expires <= Date.now()) resetConfirmations.delete(id);
			if (args[1] === "取消") {
				resetConfirmations.delete(key);
				await reply("已取消恢复默认，本群设置未修改。");
				return;
			}
			if (!args[1]) {
				if (resetConfirmations.size >= 1e3) {
					await reply("待确认操作较多，请稍后重试。");
					return;
				}
				resetConfirmations.set(key, {
					expires: Date.now() + 6e4,
					snapshot: JSON.stringify(settings)
				});
				await reply("恢复本群设置默认值\n将清除本群保存的说话频率、免打扰、上限、兴趣词、补充唤醒词、禁语和语音设置，回到配置默认。\n人设补充、钥匙授权、聊天记录与记忆保留。请本人在60秒内确认。", [{
					label: "确认恢复默认",
					command: "/群设置 重置 确认"
				}, {
					label: "取消操作",
					command: "/群设置 重置 取消"
				}]);
				return;
			}
			const pending = resetConfirmations.get(key);
			resetConfirmations.delete(key);
			if (pending?.snapshot !== JSON.stringify(settings)) {
				await reply("确认已失效或本群设置已变化。请重新查看恢复范围，再决定是否执行。", [{
					label: "重新查看范围",
					command: "/群设置 重置"
				}, {
					label: "返回设置",
					command: "/群设置 查看"
				}]);
				return;
			}
			store.reset(platform, channelId, event.UserId || "admin");
			await reply("已恢复群设置默认值；人设补充和钥匙授权保持原状。下一条消息生效。", [{
				label: "查看当前",
				command: "/群设置 查看"
			}]);
			return;
		}
		if (action === "人设" || action === "人设补充") {
			const personaAccess = await resolveIntelligenceAccess({
				platform,
				channelId,
				userId: event.UserId || "",
				owner: Boolean(event.IsMaster),
				private: false,
				admin: canEdit
			}, config);
			const operation = args[1] || "";
			const persona = getPersonaStore(config);
			const scope = {
				platform,
				channelId
			};
			const current = persona.scopeAdditions(scope);
			if (!operation || ["查看", "状态"].includes(operation)) {
				await reply(`${current ? `本群人设补充（${Array.from(current).length} 字）：\n${current}` : "本群还没有人设补充。"}\n${personaAccess.canEdit ? "填写新内容会整体替换原补充，下一轮生效。" : "仅机器人主人，或已启用 Key 权益的群管理员可编辑。"}`, [...personaAccess.canEdit ? [{
					label: "填写补充",
					command: "/群设置 人设 设置 "
				}, ...current ? [{
					label: "清空人设",
					command: "/群设置 人设 清空"
				}] : []] : [], {
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
			if (!personaAccess.canEdit) {
				await reply("本群需启用 Key 权益后，由群管理员编辑人设；机器人主人可直接编辑。查看 /我的权限 了解当前权益。");
				return;
			}
			if (operation === "清空" || operation === "删除" || operation === "移除") {
				if (!platform || !event.UserId) {
					await reply("无法确认平台或操作者，请重新发送。");
					return;
				}
				const key = JSON.stringify([
					config.workspaceRoot,
					platform,
					event.BotId || "",
					channelId,
					event.UserId
				]);
				for (const [id, entry] of personaClearConfirmations) if (entry.expires <= Date.now()) personaClearConfirmations.delete(id);
				if (args[2] === "取消") {
					personaClearConfirmations.delete(key);
					await reply("已取消清空，本群人设补充未修改。");
					return;
				}
				if (!args[2]) {
					if (!current) {
						await reply("本群没有人设补充，无需清空。");
						return;
					}
					if (personaClearConfirmations.size >= 1e3) {
						await reply("待确认操作较多，请稍后重试。");
						return;
					}
					personaClearConfirmations.set(key, {
						expires: Date.now() + 6e4,
						snapshot: current
					});
					await reply(`清空本群人设补充（${Array.from(current).length} 字）\n只清除本群补充，整群下一轮生效。人格选择、专属人设细节和共享模板保留。\n请本人在60秒内确认。`, [
						{
							label: "确认清空补充",
							command: "/群设置 人设 清空 确认"
						},
						{
							label: "取消操作",
							command: "/群设置 人设 清空 取消"
						},
						{
							label: "查看当前补充",
							command: "/群设置 人设 查看"
						}
					]);
					return;
				}
				const pending = personaClearConfirmations.get(key);
				personaClearConfirmations.delete(key);
				if (pending?.snapshot !== current) {
					await reply("确认已失效或本群人设补充已变化。请重新查看清空范围。", [{
						label: "重新查看范围",
						command: "/群设置 人设 清空"
					}, {
						label: "查看补充",
						command: "/群设置 人设 查看"
					}]);
					return;
				}
				persona.clearScopeAdditions(scope);
				await reply("已清空本群人设补充，下一轮生效；人格选择、专属人设细节和共享模板保留。", [{
					label: "查看当前补充",
					command: "/群设置 人设 查看"
				}]);
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
				await message.send({ format: sectionBubble("本群语音设置", "这里只调整本群的使用方式，成功合成还需要语音服务可用。", [{
					title: "是否允许语音",
					text: "关闭后，本群包括明确要求语音的提问也使用文字回答。",
					actions: canEdit ? [{
						label: "允许语音",
						command: "/群设置 语音 开启"
					}, {
						label: "一律文字",
						command: "/群设置 语音 关闭"
					}] : []
				}, {
					title: "何时使用语音",
					text: "关闭自动语音后，仅在明确要求时尝试合成；语音总开关关闭时，此设置暂不生效。",
					actions: canEdit ? [{
						label: "只在要求时",
						command: "/群设置 语音 自动关闭"
					}, {
						label: "允许自动",
						command: "/群设置 语音 自动开启"
					}] : []
				}], {
					platform: event.Platform,
					actions: [{
						label: "当前语音设置",
						command: "/群设置 语音 查看"
					}, {
						label: "返回设置",
						command: "/群设置 查看"
					}]
				}) });
				return;
			}
			if (operation === "查看") {
				await reply([
					`本群语音：${settings.voiceEnabled === false ? "已关闭（一律文字）" : "已允许；实际合成取决于语音服务"}`,
					`自动语音：${settings.voiceAuto === false ? "已关闭（仅明确要求时尝试）" : "已允许"}${settings.voiceEnabled === false ? "；总开关关闭，暂不生效" : ""}`,
					"设置允许语音不代表服务已经配置或试听成功。"
				].join("\n"), [...canEdit ? [
					{
						label: settings.voiceEnabled === false ? "开启语音" : "关闭语音",
						command: settings.voiceEnabled === false ? "/群设置 语音 开启" : "/群设置 语音 关闭"
					},
					{
						label: settings.voiceAuto === false ? "自动开启" : "自动关闭",
						command: settings.voiceAuto === false ? "/群设置 语音 自动开启" : "/群设置 语音 自动关闭"
					},
					{
						label: "允许语音及自动",
						command: "/群设置 语音 恢复"
					}
				] : [], {
					label: "返回设置",
					command: "/群设置 查看"
				}]);
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
			if (patch.voiceEnabled === true) done.push("已保存本群允许语音设置；实际合成取决于语音服务。");
			if (patch.voiceAuto === false) done.push("已关闭自动语音，只在明确要求时合成。");
			if (patch.voiceAuto === true) done.push("已允许自动语音；本群语音总开关关闭时暂不生效。");
			await reply(`${done.join("") || "已保存。"}\n下一条消息生效。`, [{
				label: "看看现在",
				command: "/群设置 语音 查看"
			}, {
				label: "允许语音及自动",
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
			await reply("没有识别出要调整的设置。请从设置菜单选择说话频率、免打扰、词表或语音。", [{
				label: "设置菜单",
				command: "/群设置 查看"
			}, {
				label: "操作说明",
				command: "/群设置 帮助"
			}]);
			return;
		}
		const operation = args[1] || "";
		const listField = field === "wakeNames" || field === "bannedWords";
		const listName = field === "wakeNames" ? "唤醒词" : "禁语词";
		const askingHelp = !operation || [
			"帮助",
			"怎么用",
			"用法",
			"说明"
		].includes(operation);
		if (askingHelp && listField) {
			await reply(field === "wakeNames" ? "补充本群叫机器人的词，不替换全局唤醒词。可以添加新词，或从词表选择要删除的项目。" : "禁语仅过滤机器人自己的输出。可以添加新词，或从词表选择要删除的项目。", [
				{
					label: "查看词表",
					command: `/群设置 ${action} 查看`
				},
				...canEdit ? [{
					label: "填写新词",
					command: `/群设置 ${action} 加 `
				}] : [],
				{
					label: "返回设置",
					command: "/群设置 查看"
				}
			]);
			return;
		}
		if (askingHelp) {
			await reply(helpFor[field], [{
				label: "返回设置",
				command: "/群设置 查看"
			}]);
			return;
		}
		if (listField && operation === "查看") {
			const list = settings[field] || [];
			await message.send({ format: sectionBubble(`本群${listName}`, `${list.length ? `共 ${list.length} 项` : "尚未添加"}。${field === "wakeNames" ? "这里只列本群补充词，全局唤醒词仍按配置生效。" : "只过滤机器人的输出，不限制成员发言。"}`, list.map((word) => ({
				title: word,
				text: "",
				actions: canEdit ? [{
					label: "删除此词",
					command: `/群设置 ${action} 删 ${word}`
				}] : []
			})), {
				platform: event.Platform,
				page: {
					current: Number(args[2]) || 1,
					size: 5,
					command: `/群设置 ${action} 查看`
				},
				actions: [...canEdit ? [{
					label: "填写新词",
					command: `/群设置 ${action} 加 `
				}, ...list.length ? [{
					label: `清空${listName}`,
					command: `/群设置 ${action} 清空`
				}] : []] : [], {
					label: "返回设置",
					command: "/群设置 查看"
				}]
			}) });
			return;
		}
		let value;
		let returnPage = 1;
		if (listField && (operation === "清空" || operation === "全部清空")) value = void 0;
		else if (listField && (operation === "删" || operation === "删除" || operation === "移除")) {
			const word = args.slice(2).join(" ").trim();
			const current = settings[field] || [];
			if (!word) {
				await reply("请从词表找到目标词，再选择删除此词。", [{
					label: "查看词表",
					command: `/群设置 ${action} 查看`
				}]);
				return;
			}
			if (!current.includes(word)) {
				await reply(`${listName}里没有「${word}」，可能已被删除。请先查看当前词表。`, [{
					label: "查看词表",
					command: `/群设置 ${action} 查看`
				}]);
				return;
			}
			returnPage = Math.min(Math.floor(current.indexOf(word) / 5) + 1, Math.max(1, Math.ceil((current.length - 1) / 5)));
			value = current.filter((item) => item !== word);
			if (!value.length) value = void 0;
		} else if (listField) {
			const text = (operation === "加" || operation === "添加" ? args.slice(2) : args.slice(1)).join(" ").trim();
			if (!text) {
				await reply(`添加本群${listName}\n在指令后填写新词，多个词用逗号分隔，会合并到已有词表。\n例如：/群设置 ${action} 加 小鱼`, [...canEdit ? [{
					label: "填写新词",
					command: `/群设置 ${action} 加 `
				}] : [], {
					label: "查看词表",
					command: `/群设置 ${action} 查看`
				}]);
				return;
			}
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
		const done = {
			activity: `说话频率已改成「${activityLabels[String(value)] || show(value)}」。`,
			quietHours: value === void 0 ? "静默已恢复配置默认。" : Array.isArray(value) && value[0] === value[1] ? "已取消夜间静默。" : `已设置 ${show(value)} 不主动说话；被叫仍会回。`,
			maxPerHour: value === void 0 ? "已恢复当前档位的默认上限。" : `每小时主动插话上限已保存为 ${show(value)} 次。`,
			interests: `兴趣词已更新：${show(value) || "无"}。`,
			wakeNames: value === void 0 ? "已清空本群补充的唤醒词。" : `好，以后群里说到「${show(value)}」也会找我。`,
			bannedWords: value === void 0 ? "已清空本群禁语词。" : `好，本群不会再说「${show(value)}」这个词。`
		};
		if (listField) {
			await reply(`${done[field]}\n仅影响本群。`, [{
				label: "返回词表",
				command: `/群设置 ${action} 查看 ${returnPage}`
			}, {
				label: "返回设置",
				command: "/群设置 查看"
			}]);
			return;
		}
		await reply(`${done[field] || "已保存。"}\n主人配置优先，群钥匙权益可能调整参与上限，请查看当前生效设置。`, [{
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