import { SpeechError } from "../media/speech-config.js";
import { localSpeechOptions } from "../media/local-speech.js";
import { voiceLibrary } from "../media/voice-library.js";
import { getMediaConfig } from "../media/config.js";
import { withAdminSpeechPreview } from "../media/admin-preview-context.js";
import { AdminInputError } from "./admin-error.js";
import { cachedVoiceBalance, fetchVoiceBalance } from "../media/voice-status.js";
import { renderSpeech } from "../media/speech.js";
import { getAdminStore } from "./admin-panel.js";
import { legacyVoiceAvailable, migrateLegacyVoice } from "../media/voice-migration.js";
import { getConfig } from "alemonjs";

// src/panel/voice-service.ts
const probeKey = (voice) => JSON.stringify([voice.id, voice.probeUrl]);
const probes = /* @__PURE__ */ new Map();
const voiceSnapshot = () => {
	const config = getMediaConfig();
	return {
		activeVoice: config.activeVoice,
		sampledAt: Date.now(),
		voices: (config.voices || []).map((voice) => ({
			id: voice.id,
			name: voice.name,
			enabled: voice.enabled,
			engine: voice.speech.engine,
			fallback: voice.speech.fallback,
			probe: probes.get(probeKey(voice)),
			balance: cachedVoiceBalance(config, voice)
		}))
	};
};
const voiceBalances = async (id) => {
	const config = getMediaConfig();
	if (id !== void 0 && (typeof id !== "string" || !config.voices?.some((voice) => voice.id === id))) throw new Error("音色不存在");
	const voices = (config.voices || []).filter((voice) => id === void 0 || voice.id === id);
	for (let i = 0; i < voices.length; i += 2) await Promise.all(voices.slice(i, i + 2).map((voice) => fetchVoiceBalance(config, voice, true)));
	return voiceSnapshot();
};
const readVoiceSettings = async () => {
	const snapshot = await getAdminStore().read();
	const media = JSON.parse(snapshot.source)["alemonjs-agent-link"]?.media || {};
	return {
		legacyAvailable: legacyVoiceAvailable(media),
		originalSpeech: {
			engine: media.speech?.engine || "auto",
			edgeVoice: media.speech?.edgeVoice,
			systemVoice: media.speech?.systemVoice,
			fallback: media.speech?.fallback !== false
		},
		revision: snapshot.revision,
		voices: media.voices || [],
		activeVoice: media.activeVoice || "",
		voiceRotation: media.voiceRotation ?? false,
		localSpeech: localSpeechOptions(media.localSpeech)
	};
};
const updateVoiceSettings = async (input) => {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("无效的音色设置");
	const body = input;
	if (Object.keys(body).some((key) => ![
		"revision",
		"voices",
		"activeVoice",
		"voiceRotation",
		"localSpeech",
		"legacyAvailable",
		"originalSpeech"
	].includes(key)) || typeof body.revision !== "string" || typeof body.activeVoice !== "string") throw new Error("无效的音色设置");
	if (body.voiceRotation !== void 0 && typeof body.voiceRotation !== "boolean") throw new Error("音色轮转设置无效");
	const voices = voiceLibrary(body.voices);
	if (body.activeVoice && !voices.some((voice) => voice.id === body.activeVoice)) throw new Error("音色不存在");
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化");
	const source = JSON.parse(snapshot.source);
	const app = source["alemonjs-agent-link"];
	const localSpeech = localSpeechOptions(body.localSpeech ?? app.media?.localSpeech);
	app.media = {
		...app.media,
		localSpeech,
		voices: body.voices,
		activeVoice: body.activeVoice,
		voiceRotation: body.voiceRotation ?? app.media?.voiceRotation ?? false
	};
	await store.save(JSON.stringify(source), body.revision);
	let message = "音色设置已保存";
	try {
		getConfig().reload();
	} catch {
		message = "已保存，请重启后核对运行状态";
	}
	return {
		data: await readVoiceSettings(),
		message
	};
};
const probeVoices = async (id) => {
	const config = getMediaConfig();
	if (id !== void 0 && (typeof id !== "string" || !config.voices?.some((voice) => voice.id === id))) throw new Error("音色不存在");
	for (const voice of (config.voices || []).filter((voice) => id === void 0 || voice.id === id)) {
		let status = "未配置免费测活地址";
		let httpStatus;
		if (voice.probeUrl) try {
			const response = await fetch(voice.probeUrl, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(5e3)
			});
			httpStatus = response.status;
			status = response.ok ? "可连通（不代表可合成）" : "测活未通过";
			await response.body?.cancel();
		} catch {
			status = "测活失败";
		}
		if (probes.size >= 1e3) probes.clear();
		probes.set(probeKey(voice), {
			checkedAt: Date.now(),
			status,
			httpStatus
		});
	}
	return voiceSnapshot();
};
let previewRunning = false;
/** Explicit administrator action; never invoked by refresh or diagnostics. */
const previewVoice = async (input) => {
	const body = input;
	if (!body || typeof body.text !== "string" || !body.text.trim() || Array.from(body.text).length > 200 || typeof body.id !== "string") throw new Error("试听文本需要1–200字");
	if (previewRunning) throw new Error("正在试听，请稍后重试");
	const config = getMediaConfig();
	if (body.id && !config.voices?.some((v) => v.id === body.id && v.enabled !== false)) throw new Error("音色不存在或已停用");
	previewRunning = true;
	try {
		return await withAdminSpeechPreview(() => renderSpeech(body.text, {
			...config,
			voiceRotation: false,
			activeVoice: body.id,
			speech: {
				...config.speech,
				fallback: false
			},
			voices: config.voices?.map((v) => ({
				...v,
				speech: {
					...v.speech,
					fallback: false
				}
			}))
		}, AbortSignal.timeout(Math.min(config.timeoutMs, 6e4))));
	} catch (error) {
		if (error instanceof SpeechError) throw new AdminInputError(error.detail);
		throw error;
	} finally {
		previewRunning = false;
	}
};
const migrateVoiceSettings = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string") throw new Error("迁移需要当前配置版本");
	const snapshot = await getAdminStore().read();
	if (snapshot.revision !== body.revision) throw new Error("配置已变化");
	const app = JSON.parse(snapshot.source)["alemonjs-agent-link"];
	const media = migrateLegacyVoice(app.media || {});
	return updateVoiceSettings({
		revision: body.revision,
		voices: media.voices,
		activeVoice: media.activeVoice,
		localSpeech: media.localSpeech
	});
};

export { migrateVoiceSettings, previewVoice, probeVoices, readVoiceSettings, updateVoiceSettings, voiceBalances, voiceSnapshot };