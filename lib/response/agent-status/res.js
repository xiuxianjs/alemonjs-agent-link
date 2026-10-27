import { aiDisabledMessage } from "../../dsh/ai-switch.js";
import { budgetEnabled } from "../../billing/budget.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getDSHCredentials } from "../../dsh/credentials.js";
import { getChatArchive, historyEnabled } from "../../history/store.js";
import { SessionRegistry } from "../../state/registry.js";
import { ensureDSHSupervisor } from "../../dsh/supervisor.js";
import "../../dsh/client.js";
import { getMediaConfig } from "../../media/config.js";
import { Format, ResultCode, logger, useConnection, useEvent, useMessage } from "alemonjs";

// src/response/agent-status/res.ts
const phaseMessage = {
	idle: "尚未启动；正在请求自动准备。",
	preparing: "正在准备服务。",
	installing: "正在准备服务，请稍候。",
	starting: "正在启动服务。",
	ready: "服务已就绪。",
	degraded: "纯聊天可用：网页、文件、终端工具关闭；模型连接以实际请求结果为准。",
	failed: "不可用：自动准备失败。",
	stopped: "已停止；正在请求自动恢复。"
};
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const [message] = useMessage();
	let text;
	try {
		const credentials = await getDSHCredentials();
		const config = getDSHConfig();
		const registry = new SessionRegistry(config);
		const storeReady = await registry.health();
		const supervisor = await ensureDSHSupervisor(config);
		const event = eventContext.current;
		const policy = event.ChannelId && storeReady ? await registry.policy(event.ChannelId) : void 0;
		if (config.aiEnabled !== false && !["ready", "degraded"].includes(supervisor.status().phase)) supervisor.start().catch((error) => logger.error({ err: error }, "DSH bridge status startup failed"));
		const status = supervisor.status();
		const serviceMessage = status.chatReady && status.phase !== "ready" ? "普通聊天已就绪；增强能力正在后台准备或稍后重试。" : phaseMessage[status.phase];
		let archiveStatus = "已关闭";
		if (historyEnabled(config)) try {
			getChatArchive(config);
			archiveStatus = `已开启，保留 ${config.retentionDays} 天，可查询当前会话`;
		} catch {
			archiveStatus = "不可用，请检查磁盘和权限";
		}
		let mediaStatus;
		try {
			const media = getMediaConfig();
			mediaStatus = `- 媒体配置：识图使用当前模型 / 转写 ${media.asr ? "已配置" : "未配置"} / 合成语音 ${media.tts?.voice ? "已配置" : "未配置"} / 表情库 ${media.stickerRoot ? "已配置" : "未配置"}；实际可用性需收发验证。`;
		} catch {
			mediaStatus = "- 媒体配置无效，请检查 media 配置。";
		}
		if (event.IsPrivate && event.IsMaster) {
			let transport = config.transport === "onebot" ? "OneBot（连接状态暂未核实）" : "QQ Bot";
			if (event.Platform === "onebot") {
				const [connection] = useConnection(event);
				const result = await connection.getStatus({ BotId: event.BotId });
				if (result.code === ResultCode.Ok && result.data) transport = `OneBot / ${result.data.state}；协议扩展与群权限需实际核实`;
			}
			text = [
				"# AgentLink · 管理状态",
				config.aiEnabled === false ? `- AI 请求：全局关闭，原因：${aiDisabledMessage(config)}` : "- AI 请求：开启。",
				budgetEnabled(config) ? "- 每日额度：已开启，发送 /额度 查看。" : "- 每日额度：未设置。",
				`- 平台连接：${transport}。`,
				mediaStatus,
				`- 聊天归档：${archiveStatus}。`,
				`- 服务：${!credentials ? "需要填写模型 API Key。" : !storeReady ? "会话数据暂时不可用。" : serviceMessage}`,
				status.phase !== "ready" ? "- 实际工具能力：网页、文件、终端全部关闭，优先于下方配置策略。" : "",
				`- 当前群策略：${policy ? `聊天 ${policy.chat ? "开" : "关"} / 网页 ${policy.web ? "开" : "关"} / 文件 ${policy.files ? "开" : "关"} / 终端 ${policy.terminal ? "开" : "关"}` : "请在目标群使用 /工具策略 查看。"}`,
				`- 模型凭证：${credentials ? "已从 机器人配置 中 读取。" : "尚未配置；请在 机器人配置 的 alemonjs-agent-link 下设置 apiKey。"}`
			].filter(Boolean).join("\n");
		} else text = config.aiEnabled === false ? `# AgentLink\n\n${aiDisabledMessage(config)}` : !credentials ? "# AgentLink\n\n服务尚未配置完成，请联系机器人主人。" : !storeReady ? "# AgentLink\n\n会话数据暂时不可用，请让机器人主人查看服务状态后重试。" : status.phase !== "ready" && (status.chatReady || status.phase === "degraded") ? "# AgentLink\n\n当前为纯聊天模式，可发送问题；网页、文件和终端工具暂不可用。" : status.phase === "ready" ? "# AgentLink\n\n服务正常，可以直接 @机器人 或发送 `/提问 问题`。" : `# AgentLink\n\n服务正在准备中：${phaseMessage[status.phase]} 请稍后再试。`;
		if (budgetEnabled(config) && !(event.IsPrivate && event.IsMaster)) text += "\n\n发送 /额度 可查看今日剩余额度。";
	} catch (error) {
		logger.error({ err: error }, "DSH configuration invalid while reading status");
		text = "# AgentLink\n\n服务暂时不可用，请稍后再试。";
	}
	await message.send({ format: Format.create().addMarkdownOriginal(text) });
};

export { res_default as default };