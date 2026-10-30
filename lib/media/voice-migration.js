import { speechOptions } from "./speech-config.js";
import { voiceLibrary } from "./voice-library.js";

// src/media/voice-migration.ts
/** Preserve original speech configuration; selecting the new preset makes it visible in the library. */
const migrateLegacyVoice = (media) => {
	if (!media.speech || media.activeVoice || media.voices?.length) throw new Error("仅支持尚未使用音色库的原有语音配置");
	speechOptions(media.speech);
	const voice = {
		id: "legacy-voice",
		name: `${media.speech.engine || "auto"} 原有音色`,
		enabled: true,
		speech: { ...media.speech }
	};
	voiceLibrary([voice]);
	return {
		...media,
		voices: [voice],
		activeVoice: voice.id
	};
};

export { migrateLegacyVoice };