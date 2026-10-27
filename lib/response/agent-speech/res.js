import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getConversationId } from "../dsh/util.js";
import { SpeechError } from "../../media/speech-config.js";
import { getMediaConfig } from "../../media/config.js";
import { installSpeech, renderSpeech, speechStatus } from "../../media/speech.js";
import { assertMessageDelivered } from "../../dsh/output.js";
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
		await reply("语音引擎仅限主人私聊管理。");
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
				await reply("正在安装语音组件，最长约5分钟；/取消 可取消。");
				await installSpeech(config, signal);
				await reply("语音组件已安装。请用 /语音引擎 试听 验证收发。");
			} else if (args === "试听" || args.startsWith("试听 ")) {
				const audio = await renderSpeech(args.slice(2).trim() || "你好，这是语音合成试听。", getMediaConfig(), signal, config);
				signal.throwIfAborted();
				assertMessageDelivered([await media.send({
					type: "audio",
					data: audio.data.toString("base64"),
					name: `speech-test.${audio.extension}`,
					content: `语音试听 · ${audio.engine}${audio.fallbackFrom.length ? "（已回退引擎）" : ""}`,
					replyId: event.MessageId
				})]);
			} else {
				const status = await speechStatus(config);
				const settings = getMediaConfig();
				await reply(`语音引擎：${settings.speech?.engine || "auto"}\n系统：${status.system}；edge-tts：${status.edge ? "组件已就绪" : "未安装"}\n兼容接口：${settings.tts?.voice ? "已配置" : "未配置"}\n/语音引擎 安装；/语音引擎 试听 [文本]\n实际可用性请试听确认。`);
			}
		} });
		if (!result.duplicate) await result.confirmDelivery();
	} catch (error) {
		await reply(error instanceof SpeechError ? error.detail : "语音处理未完成，请检查引擎或稍后试听。");
	}
};

export { res_default as default };