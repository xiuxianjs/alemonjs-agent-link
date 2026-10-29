import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SpeechError } from "../../media/speech-config.js";
import { getMediaConfig } from "../../media/config.js";
import { getConversationId } from "../dsh/util.js";
import { installSpeech, renderSpeech, speechStatus } from "../../media/speech.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { runCoordinatedChat } from "../../dsh/orchestrator.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMedia, useMessage, useRoute } from "alemonjs";

// src/response/agent-speech/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	const [media] = useMedia();
	const reply = async (text, actions = []) => {
		assertMessageDelivered(await message.send({ format: commandBubble(text, "语音服务", {
			platform: event.Platform,
			actions
		}) }));
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
				await reply("正在安装语音组件，最长约5分钟。", [{
					label: "取消",
					command: "/取消"
				}]);
				await installSpeech(config, signal);
				await reply("语音组件已安装，建议试听确认收发。", [{
					label: "试听",
					command: "/语音引擎 试听 你好"
				}, {
					label: "引擎状态",
					command: "/语音引擎 状态"
				}]);
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
				await reply(`语音引擎：${settings.speech?.engine || "auto"}\n系统：${status.system}；edge-tts：${status.edge ? "已就绪" : "未安装"}\n兼容接口：${settings.tts?.voice ? "已配置" : "未配置"}\n实际可用性请试听确认。`, [{
					label: "试听",
					command: "/语音引擎 试听 你好"
				}, {
					label: "安装引擎",
					command: "/语音引擎 安装"
				}]);
			}
		} });
		if (!result.duplicate) await result.confirmDelivery();
	} catch (error) {
		await reply(error instanceof SpeechError ? error.detail : "语音处理未完成，请检查引擎或稍后试听。", [{
			label: "引擎状态",
			command: "/语音引擎 状态"
		}]);
	}
};

export { res_default as default };