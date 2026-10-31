import { getMediaConfig } from "../../media/config.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { aiDisabledMessage } from "../../dsh/ai-switch.js";
import { budgetEnabled } from "../../billing/budget.js";
import { getChatArchive, historyEnabled } from "../../history/store.js";
import { getDSHCredentials } from "../../dsh/credentials.js";
import { SessionRegistry } from "../../state/registry.js";
import { ensureDSHSupervisor } from "../../dsh/supervisor.js";
import "../../dsh/client.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { ResultCode, logger, useConnection, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-status/res.ts
const phaseMessage = {
	idle: "尚未启动。",
	preparing: "正在准备。",
	installing: "正在准备，请稍候。",
	starting: "正在启动。",
	ready: "已就绪。",
	degraded: "聊天可用，网页暂不可用。",
	failed: "准备失败，请联系主人。",
	stopped: "已停止。"
};
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const [message] = useMessage();
	const [route] = useRoute();
	const event = eventContext.current;
	if (!route.matched) return;
	const args = route.rawArgs.map(String).join(" ").trim();
	if (args && args !== "详情" || args === "详情" && !(event.IsPrivate && event.IsMaster)) {
		await message.send({ format: commandBubble(args === "详情" ? "运行详情仅机器人主人可在私聊查看。当前服务情况可从概览查看。" : "没有识别出这项状态查询。请先查看概览；主人私聊可进入详情。", "服务状态", {
			platform: event.Platform,
			actions: [{
				label: "服务概览",
				command: "/状态"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	let text = "";
	let sections;
	let showBudget = false;
	try {
		const credentials = await getDSHCredentials();
		const config = getDSHConfig();
		const storeReady = await new SessionRegistry(config).health();
		const supervisor = await ensureDSHSupervisor(config);
		if (config.aiEnabled !== false && !["ready", "degraded"].includes(supervisor.status().phase)) supervisor.start().catch((error) => logger.error({ err: error }, "DSH bridge status startup failed"));
		const status = supervisor.status();
		const serviceMessage = status.chatReady && status.phase !== "ready" ? "聊天可用，增强能力正在准备。" : phaseMessage[status.phase];
		let archiveStatus = "已关闭";
		if (historyEnabled(config)) try {
			getChatArchive(config);
			archiveStatus = `已开启，保留 ${config.retentionDays} 天`;
		} catch {
			archiveStatus = "不可用，请检查磁盘和权限";
		}
		let mediaStatus;
		try {
			const media = getMediaConfig();
			mediaStatus = `识图：当前模型；转写：${media.asr ? "已配置" : "未配置"}；语音：${media.tts?.voice ? "已配置" : "未配置"}；表情：${media.stickerRoot ? "有素材目录" : "未配置"}`;
		} catch {
			mediaStatus = "媒体配置异常，请检查 media。";
		}
		if (event.IsPrivate && event.IsMaster) {
			let transport = config.transport === "onebot" ? "OneBot（连接待核实）" : "QQ Bot";
			if (event.Platform === "onebot") {
				const [connection] = useConnection(event);
				const result = await connection.getStatus({ BotId: event.BotId });
				if (result.code === ResultCode.Ok && result.data) transport = `OneBot / ${result.data.state}`;
			}
			const detail = args === "详情";
			sections = [
				{
					title: "服务",
					text: config.aiEnabled === false ? `AI 已关闭：${aiDisabledMessage(config)}` : !credentials ? "未配置模型密钥。" : !storeReady ? "会话存储不可用。" : serviceMessage,
					actions: [{
						label: "刷新",
						command: "/状态"
					}]
				},
				{
					title: "模型",
					text: `${credentials?.model || config.model}；密钥${credentials ? "已配置" : "未配置"}`,
					actions: credentials ? [{
						label: "模型列表",
						command: "/模型列表"
					}] : [{
						label: "密钥配置",
						command: "/密钥配置"
					}]
				},
				{
					title: "媒体",
					text: mediaStatus,
					actions: [{
						label: "媒体帮助",
						command: "/帮助 媒体"
					}]
				},
				{
					title: "聊天记录",
					text: archiveStatus
				},
				{
					title: "每日额度",
					text: budgetEnabled(config) ? "已开启" : "未设置",
					actions: budgetEnabled(config) ? [{
						label: "查看额度",
						command: "/额度"
					}] : []
				},
				...detail ? [
					{
						title: "平台",
						text: `平台：${transport}`
					},
					{
						title: "本群权限",
						text: "请在需要管理的目标群使用 /工具策略 查看，私聊详情不代表任何群的权限。"
					},
					{
						title: "边界",
						text: "媒体配置未实机验证；终端仅限主人私聊主动任务，需工作区就绪。"
					}
				] : [{
					title: "更多",
					text: "",
					actions: [{
						label: "详情",
						command: "/状态 详情"
					}, {
						label: "帮助",
						command: "/帮助"
					}]
				}]
			];
		} else text = config.aiEnabled === false ? `${aiDisabledMessage(config)}` : !credentials ? "模型尚未配置，请联系主人。" : !storeReady ? "会话存储暂不可用，请联系主人。" : status.phase !== "ready" && (status.chatReady || status.phase === "degraded") ? "聊天可用，网页暂不可用。" : status.phase === "ready" ? "服务正常，@我或直接提问即可。" : `${phaseMessage[status.phase]}`;
		showBudget = budgetEnabled(config);
		if (showBudget && !(event.IsPrivate && event.IsMaster)) text += "\n\n发送 /额度 可查看今日剩余额度。";
	} catch (error) {
		logger.error({ err: error }, "DSH configuration invalid while reading status");
		text = "服务暂时不可用，请稍后再试。";
	}
	if (sections) {
		const navigation = sections.filter((section) => section.title === "更多").flatMap((section) => section.actions ?? []);
		await message.send({ format: sectionBubble("服务状态", "", sections.filter((section) => section.title !== "更多"), {
			platform: event.Platform,
			actions: [
				{
					label: "刷新",
					command: route.rawArgs[0] === "详情" ? "/状态 详情" : "/状态"
				},
				...navigation,
				...route.rawArgs[0] === "详情" ? [{
					label: "返回概览",
					command: "/状态"
				}] : []
			]
		}) });
		return;
	}
	await message.send({ format: commandBubble(text, "服务状态", {
		platform: event.Platform,
		layout: "inline",
		actions: [
			{
				label: "重新查看",
				command: "/状态"
			},
			...showBudget ? [{
				label: "今日额度",
				command: "/额度"
			}] : [],
			{
				label: "帮助",
				command: "/帮助"
			}
		]
	}) });
};

export { res_default as default };