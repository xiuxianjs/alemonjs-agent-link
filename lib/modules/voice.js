import { SpeechError } from "../media/speech-config.js";
import { getMediaConfig } from "../media/config.js";
import { explicitVoiceRequest } from "../companion/voice-policy.js";
import { renderSpeech } from "../media/speech.js";
import { groupVoicePolicy } from "../social/group-settings.js";

// src/modules/voice.ts
const voiceModule = (config) => ({
	id: "voice",
	name: "语音",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const attempted = /* @__PURE__ */ new WeakSet();
		api.tool({
			name: "speak_text",
			description: "将本次需要念给当前聊天对象的文本合成为语音。用户要求语音回答、朗读、念出来时使用。不接受地址、命令或其他收件人；本轮最多一次。返回prepared只代表已合成，平台发送在完整回复后进行，不得提前声称已送达。",
			parameters: {
				type: "object",
				properties: { text: {
					type: "string",
					minLength: 1,
					maxLength: 4e3
				} },
				required: ["text"],
				additionalProperties: false
			},
			available: (context) => !context.autonomous && explicitVoiceRequest(context.userText) && Boolean(context.onSpeech) && groupVoicePolicy(config, context.channelId, context.platform).allowed,
			execute: async ({ text }, context) => {
				if (!explicitVoiceRequest(context.userText) || !groupVoicePolicy(config, context.channelId, context.platform).allowed) return {
					ok: false,
					message: "当前未明确要求语音或会话已关闭语音，请用文字回应。"
				};
				if (attempted.has(context)) return {
					ok: false,
					message: "本轮已经尝试合成语音，不重复请求。"
				};
				attempted.add(context);
				try {
					const audio = await renderSpeech(String(text), getMediaConfig(), context.signal, config);
					context.signal.throwIfAborted();
					await context.onSpeech(audio);
					return {
						ok: true,
						status: "prepared",
						engine: audio.engine,
						format: audio.extension,
						notice: "音频已合成，尚未确认平台发送；稍后由当前会话发送。"
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						stage: error instanceof SpeechError ? error.stage : "engine",
						message: error instanceof SpeechError ? error.detail : "语音引擎未完成合成，请用文字回应。"
					};
				}
			}
		});
	}
});

export { voiceModule };