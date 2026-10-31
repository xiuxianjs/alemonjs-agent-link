import { SpeechError } from "../../media/speech-config.js";
import { getMediaConfig } from "../../media/config.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getConversationId } from "../dsh/util.js";
import { runCoordinatedChat } from "../../dsh/orchestrator.js";
import { installSpeech, renderSpeech, speechStatus } from "../../media/speech.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble, sectionBubble } from "../bubble.js";
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
		if (!channelId) {
			await reply("无法识别当前私聊，请重新发送。");
			return;
		}
		if (config.modules?.disabled?.includes("voice")) {
			await reply("语音模块已停用。启用后才能安装或试听。", [{
				label: "模块状态",
				command: "/模块状态"
			}]);
			return;
		}
		if (!args || ["状态", "帮助"].includes(args)) {
			const status = await speechStatus(config);
			const settings = getMediaConfig();
			assertMessageDelivered(await message.send({ format: sectionBubble("语音引擎", `当前选择：${{
				auto: "自动选择",
				system: "系统语音",
				edge: "Edge 语音",
				openai: "兼容接口",
				fish: "Fish Audio",
				breeze: "Breeze",
				cosyvoice: "CosyVoice",
				gptsovits: "GPT-SoVITS",
				http: "HTTP 语音服务"
			}[settings.speech?.engine || "auto"]}。实际可用性请试听确认。`, [{
				title: "试听效果",
				text: `系统语音：${status.system}\n兼容接口音色：${settings.tts?.voice ? "已配置" : "未配置"}`,
				actions: [{
					label: "试听一句",
					command: "/语音引擎 试听 你好"
				}]
			}, {
				title: "Edge 语音组件",
				text: status.edge ? "组件已就绪；联网合成能否成功请试听确认。" : "组件未就绪，可安装后再试听。",
				actions: status.edge ? [] : [{
					label: "安装组件",
					command: "/语音引擎 安装"
				}]
			}], {
				platform: event.Platform,
				actions: [{
					label: "刷新状态",
					command: "/语音引擎 状态"
				}, {
					label: "媒体帮助",
					command: "/帮助 媒体"
				}]
			}) }));
			return;
		}
		if (args !== "安装" && args !== "试听" && !args.startsWith("试听 ")) {
			await reply("没有识别出这项语音操作。请先查看引擎状态，再选择安装或试听。", [{
				label: "引擎状态",
				command: "/语音引擎 状态"
			}]);
			return;
		}
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