import { speechOptions } from "./speech-config.js";
import { voiceLibrary } from "./voice-library.js";

// src/media/voice-migration.ts
const legacyVoiceAvailable = (media) => Boolean(media.speech && !(media.voices || []).some((item) => JSON.stringify(speechOptions(item.speech)) === JSON.stringify(speechOptions(media.speech))));
/** Append changed legacy configuration without replacing previously migrated voices. */
const migrateLegacyVoice = (media) => {
	if (!legacyVoiceAvailable(media)) throw new Error("没有尚未使用音色库收录的原有语音配置");
	const engine = media.speech.engine || "auto";
	let id = "legacy-voice";
	for (let suffix = 1; media.voices?.some((item) => item.id === id); suffix++) id = `legacy-${engine}-${suffix}`;
	const voice = {
		id,
		name: engine === "edge" ? `Edge ${media.speech.edgeVoice || "默认音色"}` : `${engine} 原有音色`,
		enabled: true,
		speech: { ...media.speech }
	};
	const voices = [...media.voices || [], voice];
	voiceLibrary(voices);
	return {
		...media,
		voices,
		activeVoice: voice.id
	};
};

export { legacyVoiceAvailable, migrateLegacyVoice };