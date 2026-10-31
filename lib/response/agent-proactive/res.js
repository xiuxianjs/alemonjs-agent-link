import { browsePreferences, mergeBrowseFeedback } from "../../bili/preferences.js";
import { entitledProactiveOptions, localDay, proactiveEnabled, proactiveOptions } from "../../proactive/options.js";
import { proactiveChannel } from "../../proactive/control.js";
import { browseWindow } from "../../proactive/browse-schedule.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMemoryStore } from "../../memory/store.js";
import { personalKeyEntitled } from "../../credentials/personal.js";
import { memoryEnabled } from "../../memory/consolidation.js";
import { getProactiveStore } from "../../proactive/store.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { formatReadingDiary, readingDiary, searchReadingDiary } from "../../bili/diary.js";
import { readingSettings } from "../../proactive/reading-settings.js";
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
			actions: index === chunks.length - 1 ? actions.length ? actions : [{
				label: route.rawArgs[0] === "阅读" ? "返回阅读设置" : "查看状态",
				command: route.rawArgs[0] === "阅读" ? "/主动搭话 阅读" : "/主动搭话 状态"
			}] : []
		}) }));
	};
	if (event.IsBot) {
		await reply("请在自己的私聊管理聊天偏好。", [{
			label: "我的权限",
			command: "/我的权限"
		}, {
			label: "聊天说明",
			command: "/帮助 聊天"
		}]);
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
		if (proactiveEnabled(config) && options.autoSubscribe && !store.get(scope)) store.subscribe(scope, true, options);
		const args = route.rawArgs.join(" ").trim();
		const time = (value) => new Date(value).toLocaleString("zh-CN", {
			timeZone: options.timezone,
			hour12: false
		});
		if (args.startsWith("阅读")) {
			const readingArgs = args.slice(2).trim();
			const windowMatch = readingArgs.match(/^作息\s+(\d{1,2})\s+(\d{1,2})$/u);
			if (!readingArgs || readingArgs === "状态" || readingArgs === "帮助") {
				const reading = readingSettings(config, store, scope);
				await message.send({ format: sectionBubble("独立阅读", "仅影响本人的主动搭话；需要主动聊天开启，并遵守免打扰和次数限制。", [
					{
						title: `阅读偏好${reading.enabled ? "已允许" : "未允许"}`,
						text: "此开关只保存本私聊的阅读偏好；后台执行还需符合模块开关与工具权限。是否实际阅读请查看日记和最近记录。",
						actions: [{
							label: reading.enabled ? "关闭阅读" : "开启阅读",
							command: `/主动搭话 阅读 ${reading.enabled ? "关闭" : "开启"}`
						}]
					},
					{
						title: "阅读时段",
						text: reading.window ? `${reading.window[0]}:00–${reading.window[1]}:00（${options.timezone}）` : "未单独限定阅读时段，仍遵守主动搭话作息与免打扰。",
						actions: [{
							label: "调整时段",
							command: "/主动搭话 阅读 作息"
						}]
					},
					{
						title: "阅读内容",
						text: "查看已经记录的经历，或调整想多看和避开的内容。",
						actions: [{
							label: "阅读日记",
							command: "/主动搭话 阅读 日记"
						}, {
							label: "阅读偏好",
							command: "/主动搭话 阅读 偏好"
						}]
					}
				], {
					platform: event.Platform,
					actions: [{
						label: "跟随全局",
						command: "/主动搭话 阅读 恢复默认"
					}, {
						label: "返回聊天设置",
						command: "/主动搭话 状态"
					}]
				}) });
			} else if (readingArgs === "作息") await reply("希望在哪段时间阅读？填写开始和结束整点（0–23）。例如：\n/主动搭话 阅读 作息 18 22\n表示18点开始、22点结束；也支持跨过零点。", [{
				label: "填写时段",
				command: "/主动搭话 阅读 作息 "
			}, {
				label: "返回阅读设置",
				command: "/主动搭话 阅读"
			}]);
			else if (readingArgs === "开启" || readingArgs === "关闭") {
				store.setDailyBrowse(scope, { enabled: readingArgs === "开启" });
				await reply(readingArgs === "开启" ? readingSettings(config, store, scope).enabled ? "本私聊的独立阅读偏好已保存为允许；后台执行仍需符合工具权限、主动聊天开关、免打扰与次数限制。是否实际阅读请核对日记和最近记录。" : "本私聊已允许阅读，但全局爱好开关尚未启用，暂不执行。" : "本私聊的独立阅读已关闭，正在阅读的任务已取消。");
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
					channelId: proactiveChannel(scope),
					botId: scope.botId
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
			} else await reply("没有识别出阅读操作。请返回阅读设置，选择开关、时段、日记或偏好。");
		} else if (args === "开启") {
			if (!proactiveEnabled(config)) {
				await reply("主动搭话模块或总设置已停用，请在配置中启用后再恢复主动聊天。");
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
			const subscription = store.get(scope);
			if (!subscription?.enabled) {
				await reply(subscription ? "主动聊天已关闭。请先恢复主动聊天，再调整暂停状态。" : "尚未建立自动聊天记录，请先开启主动搭话。", [{
					label: "恢复主动聊天",
					command: "/主动搭话 开启"
				}, {
					label: "查看状态",
					command: "/主动搭话 状态"
				}]);
				return;
			}
			const minutes = args === "恢复" ? 0 : Number(args.split(/\s+/u)[1]);
			if (args !== "恢复" && (minutes < 1 || minutes > 10080)) {
				await reply("暂停时长为 1–10080 分钟；想解除暂停，请选择恢复。", [{
					label: "暂停60分钟",
					command: "/主动搭话 暂停 60"
				}, {
					label: "恢复聊天",
					command: "/主动搭话 恢复"
				}]);
				return;
			}
			store.pause(scope, minutes);
			await reply(args === "恢复" ? proactiveEnabled(config) ? "本私聊已解除暂停，继续遵守作息与次数限制。" : "本私聊已解除暂停，但主动搭话模块或总设置仍停用，暂不会发送。" : `本私聊已暂停 ${minutes} 分钟，待发送消息已取消。`, [{
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
					disabled: "主动聊天已停用或当前会话不可用。",
					"not-due": "当前已关闭主动聊天、达到次数限制或已有任务。先查看 /主动搭话 状态。",
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
			const reading = readingSettings(config, store, scope);
			const browsing = reading.managed ? store.hobbyActivity(scope) : store.dailyBrowseStatus(scope);
			const browseLabels = {
				running: "已启动，尚无结束记录",
				recorded: "已保存阅读经历",
				completed: "已结束，未确认新增阅读记录",
				failed: "未完成",
				cancelled: "已取消",
				unavailable: "B站能力未开启"
			};
			const paused = row ? row.pausedUntil >= Number.MAX_SAFE_INTEGER ? "等待核查发送结果" : row.pausedUntil > Date.now() ? time(row.pausedUntil) : "" : "";
			const today = row?.day === localDay(Date.now(), options.timezone) ? row.count : 0;
			const sections = row ? [
				{
					title: "聊天设置",
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
					text: `${reading.enabled ? "独立阅读偏好已允许，后台执行仍受工具权限约束" : "独立阅读未开启"}。${reading.window ? `作息 ${reading.window[0]}:00–${reading.window[1]}:00（${options.timezone}）。` : ""}${browsing ? `最近尝试 ${time(browsing.at)}：${browseLabels[browsing.status] || "结果待核查"}。可询问“看看你的浏览日记”。` : "暂无尝试记录。"}`,
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
					title: "暂停与恢复",
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
				title: "聊天设置",
				text: "尚未建立自动聊天记录，不会主动发送消息。",
				actions: [{
					label: "开启",
					command: "/主动搭话 开启"
				}, {
					label: "状态",
					command: "/主动搭话 状态"
				}]
			}];
			await message.send({ format: sectionBubble("主动搭话", "每个人均可在自己的私聊管理；默认自动开启，可随时关闭。", sections, {
				platform: event.Platform,
				layout: "inline"
			}) });
		} else await reply("没有识别出这次操作。请查看聊天设置状态，再选择开启、暂停或恢复。", [{
			label: "查看状态",
			command: "/主动搭话 状态"
		}]);
	} catch {
		await reply("操作结果暂时无法确认。请先核对状态，再决定是否重试。", [{
			label: "查看状态",
			command: "/主动搭话 状态"
		}]);
	}
};

export { res_default as default };