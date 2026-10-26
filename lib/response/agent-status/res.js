import { getDSHCredentials } from "../../dsh/credentials.js";
import { SessionRegistry } from "../../state/registry.js";
import { ensureDSHSupervisor } from "../../dsh/supervisor.js";
import { getDSHConfig } from "../../dsh/client.js";
import { getRequestCapacity } from "../../dsh/orchestrator.js";
import { getMediaConfig } from "../../media/config.js";
import { Format, logger, useEvent, useMessage } from "alemonjs";

// src/response/agent-status/res.ts
const phaseMessage = {
	idle: "尚未启动；正在请求自动准备。",
	preparing: "正在检查 Python 与 DSH 环境。",
	installing: "正在自动创建 Python 环境并安装 deepseek-harness-sdk。",
	starting: "SDK 已准备，正在启动本地 DSH Bridge。",
	ready: "已就绪：DSH Bridge 和 Python SDK 可用。",
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
		if (!["ready", "degraded"].includes(supervisor.status().phase)) supervisor.start().catch((error) => logger.error({ err: error }, "DSH bridge status startup failed"));
		const status = supervisor.status();
		const capacity = getRequestCapacity();
		let mediaStatus;
		try {
			const media = getMediaConfig();
			mediaStatus = `- 媒体配置：识图 DSH 当前模型（默认） / 转写 ${media.asr ? "已配置" : "未配置"} / 合成语音 ${media.tts?.voice ? "已配置" : "未配置"} / 表情库 ${media.stickerRoot ? "已配置" : "未配置"}；实际可用性需收发验证。`;
		} catch {
			mediaStatus = "- 媒体配置无效，请检查 media 配置。";
		}
		if (event.IsPrivate && event.IsMaster) text = [
			"# AgentLink · 管理状态",
			mediaStatus,
			`- 服务：${phaseMessage[status.phase]}`,
			`- 会话状态库（${config.stateBackend === "local" ? "本地持久化" : "Redis"}）：${storeReady ? "已连接。" : "不可用；新的 Agent 请求会被拒绝。"}`,
			`- Bridge：${status.phase === "ready" ? "已就绪。" : "尚未就绪。"}`,
			`- Sandbox：${status.phase === "ready" ? "前置检查已通过。" : "尚未通过前置检查。"}`,
			status.phase === "degraded" ? "- 实际工具能力：网页、文件、终端全部关闭，优先于下方配置策略。" : "",
			`- 容量：${capacity.active}/${config.maxConcurrentRequests} 个活跃请求；最多 ${config.maxActiveWorkers} 个隔离 Worker。`,
			`- 当前群策略：${policy ? `聊天 ${policy.chat ? "开" : "关"} / 网页 ${policy.web ? "开" : "关"} / 文件 ${policy.files ? "开" : "关"} / 终端 ${policy.terminal ? "开" : "关"}` : "主人私聊：全部开启。"}`,
			`- 模型凭证：${credentials ? "已从 机器人配置 中 读取。" : "尚未配置；请在 机器人配置 的 alemonjs-agent-link 下设置 apiKey。"}`,
			"- 数据清理：启动时一次，此后每小时检查；默认保留 30 天。",
			status.detail ? `\n> 说明：${status.detail}` : ""
		].filter(Boolean).join("\n");
		else text = status.phase === "degraded" ? "# AgentLink\n\n当前为纯聊天模式，可发送问题；网页、文件和终端工具暂不可用。" : status.phase === "ready" ? "# AgentLink\n\n服务正常，可以直接 @机器人 或发送 `/chat 问题`。" : `# AgentLink\n\n服务正在准备中：${phaseMessage[status.phase]} 请稍后再试。`;
	} catch (error) {
		logger.error({ err: error }, "DSH configuration invalid while reading status");
		text = "# AgentLink\n\n服务暂时不可用，请稍后再试。";
	}
	await message.send({ format: Format.create().addMarkdownOriginal(text) });
};

export { res_default as default };