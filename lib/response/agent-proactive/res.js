import { getDSHConfig } from "../../dsh/runtime-config.js";
import { localDay, proactiveEnabled, proactiveOptions } from "../../proactive/options.js";
import { getProactiveStore } from "../../proactive/store.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { ProactiveWorker } from "../../proactive/worker.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-proactive/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	let limit = 900;
	const reply = async (text) => {
		const chars = Array.from(text);
		for (let i = 0; i < chars.length; i += limit) assertMessageDelivered(await message.send({ format: Format.create().addText(chars.slice(i, i + limit).join("")) }));
	};
	if (!event.IsMaster || event.IsBot) {
		await reply("主动搭话只由已验证主人在自己的私聊中管理。");
		return;
	}
	if (!event.Platform || !event.BotId || !event.UserId) {
		await reply("缺少明确的平台、机器人或私聊身份。");
		return;
	}
	try {
		const config = getDSHConfig();
		limit = Math.min(900, config.maxMessageLength);
		const options = proactiveOptions(config);
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
		if (args === "开启") {
			if (!proactiveEnabled(config)) {
				await reply("主动搭话模块或总设置已停用，请在配置中启用后再开启订阅。");
				return;
			}
			store.subscribe(scope, true, options);
			await reply("已开启自己的主动搭话订阅。会遵守空闲、免打扰和次数限制；可用 /主动搭话 关闭 停止。");
		} else if (args === "关闭") {
			store.subscribe(scope, false, options);
			await reply("已关闭自己的主动搭话订阅，并取消尚未发送的搭话。");
		} else if (args === "恢复" || /^暂停\s+\d{1,5}$/u.test(args)) {
			if (!store.get(scope)) {
				await reply("尚未订阅，请先使用 /主动搭话 开启。");
				return;
			}
			store.pause(scope, args === "恢复" ? 0 : Number(args.split(/\s+/u)[1]));
			await reply(args === "恢复" ? "已解除暂停；后续继续遵守调度和次数限制。" : "已暂停主动搭话，并取消尚未发送的搭话。");
		} else if (args === "现在") {
			const worker = new ProactiveWorker(config);
			try {
				await reply({
					confirmed: "主动搭话已送达。",
					silent: "这次选择保持安静，没有发送搭话。",
					unknown: "发送结果未确认，已暂停主动搭话。请先核对平台消息，再用 /主动搭话 恢复。",
					cancelled: "搭话已取消。",
					failed: "本次未完成，没有自动重试。",
					disabled: "主动搭话已停用或当前身份不再是主人。",
					"not-due": "当前未订阅、达到次数限制或已有任务。先查看 /主动搭话 状态。",
					offline: "平台尚未确认在线，未生成或发送搭话。",
					busy: "已有主动搭话任务在执行，请稍后重试。"
				}[await worker.run(scope, true)]);
			} finally {
				worker.stop();
			}
		} else if (!args || args === "状态") {
			store.recover();
			const row = store.get(scope);
			const attempts = store.attempts(scope);
			await reply(`${row ? [
				`当前私聊订阅：${row.enabled ? "开启" : "关闭"}；模块：${proactiveEnabled(config) ? "启用" : "停用"}。`,
				`暂停：${row.pausedUntil >= Number.MAX_SAFE_INTEGER ? "等待核查发送结果" : row.pausedUntil > Date.now() ? time(row.pausedUntil) : "无"}。`,
				`今日初次搭话 ${row.day === localDay(Date.now(), options.timezone) ? row.count : 0}/${options.maxPerDay}；未回复连发 ${row.unanswered}/${options.maxUnanswered}。`,
				`下次最早计划：${time(row.nextAt)}，仍需满足空闲和免打扰规则。`,
				...attempts.map((attempt) => `${time(attempt.at)} ${attempt.kind === "nudge" ? "追问" : "搭话"}：${attempt.status}`)
			].join("\n") : "尚未订阅，不会主动发送消息。"}\n用法：/主动搭话 开启|关闭|状态|现在|暂停 分钟|恢复。`);
		} else await reply("用法：/主动搭话 开启|关闭|状态|现在|暂停 分钟|恢复。");
	} catch {
		await reply("主动搭话操作未完成，请检查设置或稍后核对状态。");
	}
};

export { res_default as default };