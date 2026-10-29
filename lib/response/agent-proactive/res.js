import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMemoryStore } from "../../memory/store.js";
import { proactiveChannel } from "../../proactive/control.js";
import { entitledProactiveOptions, localDay, proactiveEnabled, proactiveOptions } from "../../proactive/options.js";
import { browseWindow } from "../../proactive/browse-schedule.js";
import { getProactiveStore } from "../../proactive/store.js";
import { personalKeyEntitled } from "../../credentials/personal.js";
import { memoryEnabled } from "../../memory/consolidation.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { browsePreferences, mergeBrowseFeedback } from "../../bili/preferences.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { formatReadingDiary, readingDiary, searchReadingDiary } from "../../bili/diary.js";
import { ProactiveWorker } from "../../proactive/worker.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-proactive/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	let limit = 900;
	const reply = async (text, actions = []) => {
		const chars = Array.from(text);
		const chunks = [];
		for (let i = 0; i < chars.length; i += limit) chunks.push(chars.slice(i, i + limit).join(""));
		for (const [index, chunk] of chunks.entries()) assertMessageDelivered(await message.send({ format: commandBubble(chunk, "主动搭话", {
			platform: event.Platform,
			actions: index === chunks.length - 1 ? actions : []
		}) }));
	};
	if (!event.IsMaster || event.IsBot) {
		await reply("请主人在自己的私聊管理主动搭话。");
		return;
	}
	if (!event.Platform || !event.BotId || !event.UserId) {
		await reply("缺少明确的平台、机器人或私聊身份。");
		return;
	}
	try {
		const config = getDSHConfig();
		limit = Math.min(900, config.maxMessageLength);
		let options = proactiveOptions(config);
		let elevated = false;
		try {
			if (await personalKeyEntitled({
				platform: event.Platform,
				userId: event.UserId
			})) {
				options = entitledProactiveOptions(options);
				elevated = Boolean(options.flexible);
			}
		} catch {}
		const store = getProactiveStore(config);
		const scope = {
			platform: event.Platform,
			botId: event.BotId,
			userId: event.UserId
		};
		const args = route.rawArgs.join(" ").trim();
		const time = (value) => new Date(value).toLocaleString("zh-CN", {
			timeZone: options.timezone,
			hour12: false
		});
		if (args.startsWith("阅读")) {
			const readingArgs = args.slice(2).trim();
			const windowMatch = readingArgs.match(/^作息\s+(\d{1,2})\s+(\d{1,2})$/u);
			if (readingArgs === "开启" || readingArgs === "关闭") {
				store.setDailyBrowse(scope, { enabled: readingArgs === "开启" });
				await reply(readingArgs === "开启" ? "本私聊的每日阅读已开启；需保持主动搭话订阅，遵守暂停、免打扰和每日次数限制。" : "本私聊的每日阅读已关闭，正在阅读的任务已取消。");
			} else if (windowMatch) {
				if (Number(windowMatch[1]) > 23 || Number(windowMatch[2]) > 23 || windowMatch[1] === windowMatch[2] || Number(windowMatch[1]) === Number(windowMatch[2])) {
					await reply("阅读作息需要两个不同的 0–23 整点，例如“/主动搭话 阅读 作息 18 22”。");
					return;
				}
				const window = browseWindow([Number(windowMatch[1]), Number(windowMatch[2])]);
				store.setDailyBrowse(scope, { window });
				await reply(`阅读作息已保存：${window[0]}:00–${window[1]}:00（${options.timezone}），结束时间不包含在窗口内。`);
			} else if (readingArgs === "恢复默认") {
				store.resetDailyBrowse(scope);
				await reply("阅读开关和作息已恢复跟随全局配置。");
			} else if (/^日记(?:\s+[1-7](?:\s+.{1,80})?)?$/u.test(readingArgs)) {
				if (!memoryEnabled(config)) {
					await reply("记忆模块已停用，暂不能查看阅读日记。");
					return;
				}
				const [, dayText, ...words] = readingArgs.split(/\s+/u);
				const days = Number(dayText || 1);
				const query = words.join(" ");
				const records = getMemoryStore(config).list({
					platform: scope.platform,
					channelId: proactiveChannel(scope)
				}, {
					subjectId: scope.botId,
					status: "active",
					limit: 2e3
				});
				const entries = searchReadingDiary(readingDiary(records, days * 24), query);
				await reply((query ? `关键词：${query}（字面匹配）\n` : "") + formatReadingDiary(entries, days * 24, options.timezone) + (records.length >= 2e3 ? "\n仅检查最近 2000 条机器人记录，更早内容可能未包含。" : ""));
			} else if (readingArgs === "偏好") {
				const feedback = store.browseFeedback(scope);
				const effective = mergeBrowseFeedback(browsePreferences(config.modules?.settings?.bili || {}), feedback);
				await reply(`当前有效阅读偏好\n多看：${effective.topics.join("、") || "未指定，按人格兴趣选题"}\n避开：${effective.exclude.join("、") || "未指定"}\n已合并全局配置与本私聊反馈，避雷优先。可说“以后多看独立游戏”“以后别看恐怖”或“恢复推荐恐怖”；恢复推荐不会移除全局避雷词。`);
			} else await reply("用法：/主动搭话 阅读 开启|关闭|作息 18 22|恢复默认|偏好|日记 [1-7] [关键词]。");
		} else if (args === "开启") {
			if (!proactiveEnabled(config)) {
				await reply("主动搭话模块或总设置已停用，请在配置中启用后再开启订阅。");
				return;
			}
			store.subscribe(scope, true, options);
			await reply("主动搭话已开启，遵守免打扰与次数限制。", [{
				label: "查看状态",
				command: "/主动搭话 状态"
			}, {
				label: "关闭",
				command: "/主动搭话 关闭"
			}]);
		} else if (args === "关闭") {
			store.subscribe(scope, false, options);
			await reply("主动搭话已关闭，待发送消息已取消。", [{
				label: "查看状态",
				command: "/主动搭话 状态"
			}, {
				label: "重新开启",
				command: "/主动搭话 开启"
			}]);
		} else if (args === "恢复" || /^暂停\s+\d{1,5}$/u.test(args)) {
			if (!store.get(scope)) {
				await reply("尚未订阅，请先使用 /主动搭话 开启。");
				return;
			}
			store.pause(scope, args === "恢复" ? 0 : Number(args.split(/\s+/u)[1]));
			await reply(args === "恢复" ? "主动搭话已恢复。" : "已暂停，待发送消息已取消。", [{
				label: "查看状态",
				command: "/主动搭话 状态"
			}, ...args === "恢复" ? [] : [{
				label: "恢复",
				command: "/主动搭话 恢复"
			}]]);
		} else if (args === "现在") {
			const worker = new ProactiveWorker(config);
			try {
				await reply({
					confirmed: "主动搭话已送达。",
					silent: "这次保持安静，未发消息。",
					unknown: "发送结果未确认，已暂停主动搭话。请先核对平台消息，再用 /主动搭话 恢复。",
					cancelled: "搭话已取消。",
					failed: "本次未完成，未自动重试。",
					disabled: "主动搭话已停用或当前身份不再是主人。",
					"not-due": "当前未订阅、达到次数限制或已有任务。先查看 /主动搭话 状态。",
					offline: "平台尚未确认在线，未生成或发送搭话。",
					busy: "已有主动搭话任务在执行，请稍后重试。"
				}[await worker.run(scope, true)], [{
					label: "查看状态",
					command: "/主动搭话 状态"
				}]);
			} finally {
				worker.stop();
			}
		} else if (!args || args === "状态") {
			store.recover();
			const row = store.get(scope);
			const attempts = store.attempts(scope);
			const browsing = store.dailyBrowseStatus(scope);
			const reading = store.dailyBrowseSettings(scope, config.modules?.settings?.bili?.dailyBrowse === true, browseWindow(config.modules?.settings?.bili?.dailyBrowseWindow));
			const browseLabels = {
				running: "已启动，尚无结束记录",
				recorded: "已保存阅读经历",
				completed: "已结束，未确认新增阅读记录",
				failed: "未完成",
				cancelled: "已取消"
			};
			const paused = row ? row.pausedUntil >= Number.MAX_SAFE_INTEGER ? "等待核查发送结果" : row.pausedUntil > Date.now() ? time(row.pausedUntil) : "" : "";
			const today = row?.day === localDay(Date.now(), options.timezone) ? row.count : 0;
			const sections = row ? [
				{
					title: "订阅",
					text: `${row.enabled ? "已开启" : "已关闭"}；模块${proactiveEnabled(config) ? "启用" : "停用"}。`,
					actions: [row.enabled ? {
						label: "关闭",
						command: "/主动搭话 关闭"
					} : {
						label: "开启",
						command: "/主动搭话 开启"
					}, {
						label: "立即",
						command: "/主动搭话 现在"
					}]
				},
				{
					title: "节奏",
					text: `今日 ${today}/${options.maxPerDay}；未回复连发 ${row.unanswered}/${options.maxUnanswered}；最早下次 ${time(row.nextAt)}。`
				},
				{
					title: "独立阅读",
					text: `${reading.enabled ? "每日阅读已配置开启" : "每日阅读未开启"}。${reading.window ? `作息 ${reading.window[0]}:00–${reading.window[1]}:00（${options.timezone}）。` : ""}${browsing ? `最近尝试 ${time(browsing.at)}：${browseLabels[browsing.status] || "结果待核查"}。可询问“看看你的浏览日记”。` : "暂无尝试记录。"}`,
					actions: [
						{
							label: reading.enabled ? "关闭阅读" : "开启阅读",
							command: `/主动搭话 阅读 ${reading.enabled ? "关闭" : "开启"}`
						},
						{
							label: "阅读偏好",
							command: "/主动搭话 阅读 偏好"
						},
						{
							label: "阅读日记",
							command: "/主动搭话 阅读 日记"
						}
					]
				},
				...paused ? [{
					title: "暂停",
					text: paused,
					actions: row.pausedUntil < Number.MAX_SAFE_INTEGER ? [{
						label: "恢复",
						command: "/主动搭话 恢复"
					}] : []
				}] : [],
				...elevated ? [{
					title: "自带 Key",
					text: "主动搭话已拉满（空闲 20 分钟、每天最多 10 次）；免打扰仍按配置。"
				}] : [],
				...args === "状态" && attempts.length > 0 ? [{
					title: "最近记录",
					text: attempts.slice(0, 5).map((attempt) => `${time(attempt.at)} ${attempt.kind === "nudge" ? "追问" : "搭话"}：${{
						confirmed: "已送达",
						unknown: "待核对",
						failed: "失败",
						cancelled: "已取消",
						silent: "未发送",
						sending: "发送中",
						reserved: "待处理"
					}[attempt.status] || attempt.status}`).join("\n")
				}] : [],
				{
					title: "更多",
					text: "需要时暂停；恢复不会补发错过的消息。",
					actions: [{
						label: "暂停 60 分钟",
						command: "/主动搭话 暂停 60"
					}, {
						label: "恢复",
						command: "/主动搭话 恢复"
					}]
				}
			] : [{
				title: "订阅",
				text: "尚未订阅，不会主动发送消息。",
				actions: [{
					label: "开启",
					command: "/主动搭话 开启"
				}, {
					label: "状态",
					command: "/主动搭话 状态"
				}]
			}];
			await message.send({ format: sectionBubble("主动搭话", "仅主人私聊。", sections, {
				platform: event.Platform,
				layout: "inline"
			}) });
		} else await reply("用法：/主动搭话 开启|关闭|状态|现在|暂停 分钟|恢复。", [{
			label: "查看状态",
			command: "/主动搭话 状态"
		}]);
	} catch {
		await reply("操作未完成，请核对状态后再试。", [{
			label: "查看状态",
			command: "/主动搭话 状态"
		}]);
	}
};

export { res_default as default };