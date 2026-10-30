import { SpeechError } from "./speech-config.js";

// src/media/local-speech.ts
const localSpeechOptions = (value = {}) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechError("configuration", "本地音色设置无效。");
	const raw = value;
	const result = {
		enabled: raw.enabled ?? true,
		fallback: raw.fallback ?? true,
		voice: typeof raw.voice === "string" ? raw.voice.trim() || void 0 : void 0
	};
	if (typeof result.enabled !== "boolean" || typeof result.fallback !== "boolean" || raw.voice !== void 0 && (typeof raw.voice !== "string" || raw.voice.length > 200 || /[\r\n\0]/u.test(raw.voice))) throw new SpeechError("configuration", "本地音色设置无效。");
	return result;
};

export { localSpeechOptions };