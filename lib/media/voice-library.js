import { SpeechError, speechOptions } from "./speech-config.js";
import { localSpeechOptions } from "./local-speech.js";

// src/media/voice-library.ts
const voiceLibrary = (value) => {
	if (value === void 0) return [];
	if (!Array.isArray(value) || value.length > 100) throw new SpeechError("configuration", "音色库最多100项。");
	const ids = /* @__PURE__ */ new Set();
	return value.map((item) => {
		if (!item || typeof item !== "object" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 || item.ttsVoice !== void 0 && (typeof item.ttsVoice !== "string" || !item.ttsVoice.trim() || item.ttsVoice.length > 200)) throw new SpeechError("configuration", "音色库名称、ID或音色无效，ID不可重复。");
		if (item.enabled !== void 0 && typeof item.enabled !== "boolean") throw new SpeechError("configuration", "音色启停状态无效。");
		if (item.balanceUrl !== void 0) {
			if (typeof item.balanceUrl !== "string" || !item.balanceUrl.includes("{key}")) throw new SpeechError("configuration", "额度查询地址需要 {key}。");
			const url = new URL(item.balanceUrl.replaceAll("{key}", "test"));
			if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new SpeechError("configuration", "额度查询地址需要无凭证的HTTPS地址。");
		}
		if (item.probeUrl !== void 0) {
			const url = new URL(item.probeUrl);
			if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new SpeechError("configuration", "测活地址需要无查询参数的HTTPS地址。");
		}
		ids.add(item.id);
		return {
			id: item.id,
			name: item.name,
			enabled: item.enabled ?? true,
			balanceUrl: item.balanceUrl,
			probeUrl: item.probeUrl,
			speech: speechOptions(item.speech),
			ttsVoice: item.ttsVoice
		};
	});
};
const selectVoice = (config, validateOnly = false) => {
	if (!config.activeVoice) return config;
	const preset = voiceLibrary(config.voices).find((item) => item.id === config.activeVoice);
	if (!preset) throw new SpeechError("configuration", "所选音色不在音色库中。");
	if (preset.enabled === false) {
		if (validateOnly) return config;
		if (preset.speech.fallback === false || !localSpeechOptions(config.localSpeech).enabled || !localSpeechOptions(config.localSpeech).fallback) throw new SpeechError("configuration", "当前音色已停用。");
		return {
			...config,
			speech: {
				engine: "system",
				fallback: true
			}
		};
	}
	if (preset.ttsVoice && !config.tts) throw new SpeechError("configuration", "该音色需要配置 media.tts。");
	return {
		...config,
		speech: preset.speech,
		tts: config.tts ? {
			...config.tts,
			voice: preset.ttsVoice || config.tts.voice
		} : void 0
	};
};

export { selectVoice, voiceLibrary };