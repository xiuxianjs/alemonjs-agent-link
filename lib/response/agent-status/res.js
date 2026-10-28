import { aiDisabledMessage } from "../../dsh/ai-switch.js";
import { budgetEnabled } from "../../billing/budget.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getDSHCredentials } from "../../dsh/credentials.js";
import { getChatArchive, historyEnabled } from "../../history/store.js";
import { SessionRegistry } from "../../state/registry.js";
import { ensureDSHSupervisor } from "../../dsh/supervisor.js";
import "../../dsh/client.js";
import { getMediaConfig } from "../../media/config.js";
import { commandBubble } from "../bubble.js";
import { ResultCode, logger, useConnection, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-status/res.ts
const phaseMessage = {
	idle: "尚未就绪，正在准备。",
	preparing: "正在准备。",
	installing: "正在准备，请稍候。",
	starting: "正在启动。",
	ready: "已就绪。",
	degraded: "聊天可用，网页暂不可用。",
	failed: "准备失败，请联系主人。",
	stopped: "已停止，正在恢复。"
};
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const [message] = useMessage();
	const [route] = useRoute();
	const event = eventContext.current;
	let text;
	let showBudget = false;
	try {
		const credentials = await getDSHCredentials();
		const config = getDSHConfig();
		const registry = new SessionRegistry(config);
		const storeReady = await registry.health();
		const supervisor = await ensureDSHSupervisor(config);
		const policy = event.ChannelId && storeReady ? await registry.policy(event.ChannelId) : void 0;
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
			text = [
				"服务状态",
				config.aiEnabled === false ? `AI 已关闭：${aiDisabledMessage(config)}` : `服务：${!credentials ? "未配置模型密钥。" : !storeReady ? "会话存储不可用。" : serviceMessage}`,
				`模型：${credentials?.model || config.model}；密钥${credentials ? "已配置" : "未配置"}`,
				mediaStatus,
				`聊天记录：${archiveStatus}`,
				`每日额度：${budgetEnabled(config) ? "已开启，/额度 查看" : "未设置"}`,
				...route.matched && route.rawArgs.map(String).includes("详情") ? [
					`平台：${transport}`,
					`本群权限：${policy ? `聊天${policy.chat ? "开" : "关"}、网页${policy.web ? "开" : "关"}、文件${policy.files ? "开" : "关"}` : "请在目标群使用 /工具策略 查看"}`,
					"媒体配置不代表服务已验证；终端禁止。"
				] : ["/状态 详情：平台与权限"]
			].join("\n");
		} else text = config.aiEnabled === false ? `${aiDisabledMessage(config)}` : !credentials ? "模型尚未配置，请联系主人。" : !storeReady ? "会话存储暂不可用，请联系主人。" : status.phase !== "ready" && (status.chatReady || status.phase === "degraded") ? "聊天可用，网页暂不可用。" : status.phase === "ready" ? "服务正常，@我或直接提问即可。" : `${phaseMessage[status.phase]}`;
		showBudget = budgetEnabled(config);
		if (showBudget && !(event.IsPrivate && event.IsMaster)) text += "\n\n发送 /额度 可查看今日剩余额度。";
	} catch (error) {
		logger.error({ err: error }, "DSH configuration invalid while reading status");
		text = "服务暂时不可用，请稍后再试。";
	}
	await message.send({ format: commandBubble(text, "服务状态", {
		platform: event.Platform,
		actions: [
			{
				label: "重新查看",
				command: "/状态"
			},
			...event.IsPrivate && event.IsMaster ? [{
				label: "状态详情",
				command: "/状态 详情"
			}] : [],
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