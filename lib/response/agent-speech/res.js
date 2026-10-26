import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SpeechError } from "../../media/speech-config.js";
import { getMediaConfig } from "../../media/config.js";
import { installSpeech, renderSpeech, speechStatus } from "../../media/speech.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { getConversationId } from "../dsh/util.js";
import { runCoordinatedChat } from "../../dsh/orchestrator.js";
import { Format, useEvent, useMedia, useMessage, useRoute } from "alemonjs";

// src/response/agent-speech/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	const [media] = useMedia();
	const reply = async (text) => {
		assertMessageDelivered(await message.send({ format: Format.create().addText(text) }));
	};
	if (!event.IsMaster) {
		await reply("语音引擎管理仅限已验证主人私聊。");
		return;
	}
	try {
		const config = getDSHConfig();
		const args = route.rawArgs.join(" ").trim();
		const channelId = getConversationId(event);
		if (!channelId) return;
		const result = await runCoordinatedChat({
			...event,
			ChannelId: channelId
		}, event.MessageText || "", () => Promise.resolve(), void 0, void 0, void 0, void 0, { execute: async (signal) => {
			if (config.modules?.disabled?.includes("voice")) {
				await reply("语音模块已停用。");
				return;
			}
			if (args === "安装") {
				await reply("正在准备独立 edge-tts 环境，最长约5分钟；可用 /cancel 取消。");
				await installSpeech(config, signal);
				await reply("edge-tts 组件已安装并通过导入检查。请用 /语音引擎 试听 验证服务及平台收发。");
			} else if (args === "试听" || args.startsWith("试听 ")) {
				const audio = await renderSpeech(args.slice(2).trim() || "你好，这是语音合成试听。", getMediaConfig(), signal, config);
				signal.throwIfAborted();
				assertMessageDelivered([await media.send({
					type: "audio",
					data: audio.data.toString("base64"),
					name: `speech-test.${audio.extension}`,
					content: "AI 合成语音",
					replyId: event.MessageId
				})]);
				await reply(`试听已由平台确认发送。引擎：${audio.engine}，格式：${audio.extension}${audio.fallbackFrom.length ? `；此前未完成：${audio.fallbackFrom.join("、")}` : ""}。`);
			} else {
				const status = await speechStatus(config);
				const settings = getMediaConfig();
				await reply(`语音引擎：${settings.speech?.engine || "auto"}\n系统路径：${status.system}（实际可用性以试听为准）\nedge-tts：${status.edge ? "组件可导入，在线服务需试听" : "未就绪，可用 /语音引擎 安装"}\n兼容接口：${settings.tts?.voice ? "已配置，需试听" : "未配置"}\n用法：/语音引擎 状态|安装|试听 [文本]。系统语音不需要模型密钥；edge-tts 需联网。`);
			}
		} });
		if (!result.duplicate) await result.confirmDelivery();
	} catch (error) {
		await reply(error instanceof SpeechError ? error.detail : "语音引擎检测、合成或平台发送未完成，请检查当前阶段；密钥和原文未写入错误信息。");
	}
};

export { res_default as default };