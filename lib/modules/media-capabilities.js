import { selectVoice } from "../media/voice-library.js";
import { getMediaConfig } from "../media/config.js";
import { videoDecoderAvailable } from "../media/video-input.js";
import { visionSource } from "../media/vision.js";
import { dshImagePreparationStatus } from "../media/dsh-image-generation.js";

// src/modules/media-capabilities.ts
/** Capability discovery never returns provider URLs, keys, cookies or host paths. */
const mediaCapabilitiesModule = () => ({
	id: "media-capabilities",
	name: "媒体能力状态",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		api.tool({
			name: "media_capabilities",
			readOnly: true,
			description: "查询语音、看图、生图、视频能力的配置状态。配置就绪不代表供应商连通或平台发送成功；生视频仅预留入口，不能生成。",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			available: (context) => !context.autonomous,
			execute: async (_args, context) => {
				const media = getMediaConfig();
				const voice = media.voiceRotation ? media : selectVoice(media);
				const decoder = await videoDecoderAvailable();
				const visual = visionSource(media);
				return {
					asr: media.asr ? "configured" : "platform_transcript_only",
					speech: {
						engine: voice.speech?.engine || "auto",
						providerConfigured: Boolean(voice.tts || voice.speech?.url),
						systemFallbackEnabled: Boolean(media.localSpeech?.enabled),
						rotationEnabled: Boolean(media.voiceRotation),
						enabledVoiceCount: media.voices?.filter((item) => item.enabled !== false).length || 0
					},
					vision: visual ? "configured" : "main_model_support_required",
					visionSource: visual || "main_model_unverified",
					imageGeneration: media.imageGen && (!media.imageGen.ownerOnly || context.owner) ? "configured" : "unavailable",
					dshImageFallback: Boolean(media.dshImageFallback && media.imageGen && (!media.imageGen.ownerOnly || context.owner)),
					dshImagePlugin: dshImagePreparationStatus(),
					videoUnderstanding: !decoder ? "decoder_missing" : visual ? "mp4_sampled_frames_not_full_video_or_audio" : "decoder_present_vision_model_unverified",
					videoGeneration: {
						status: "reserved",
						enabled: false,
						message: "尚未接入视频生成供应商，不提交生成任务。"
					},
					evidence: "仅配置和本地依赖检查，未调用收费服务，也未验证平台投递。"
				};
			}
		});
	}
});

export { mediaCapabilitiesModule };