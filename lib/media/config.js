import { speechOptions } from "./speech-config.js";
import { localSpeechOptions } from "./local-speech.js";
import { selectVoice, voiceLibrary } from "./voice-library.js";
import { join, resolve } from "node:path";
import { getAppConfigValue } from "alemonjs";

// src/media/config.ts
var MediaError = class extends Error {};
const unavailableMediaReply = "看不懂，就当是夸我了";
var MediaUnavailableError = class extends MediaError {
	constructor() {
		super(unavailableMediaReply);
	}
};
const defaultStickerRoot = () => resolve(process.env.AGENT_LINK_DATA_DIR ?? join(process.cwd(), ".data", "agent-link"), "stickers");
const provider = (value, allowLocal = false) => {
	if (value === void 0) return;
	if (!value || typeof value !== "object") throw new MediaError("媒体服务配置无效。");
	const input = value;
	if (![input.baseUrl, input.model].every((item) => typeof item === "string" && item.trim())) throw new MediaError("媒体服务需要独立配置 baseUrl、apiKey 和 model。");
	let url;
	try {
		url = new URL(input.baseUrl);
	} catch {
		throw new MediaError("媒体服务地址无效。");
	}
	const local = allowLocal && [
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname);
	if (url.protocol !== "https:" && !(local && url.protocol === "http:") || url.username || url.password || url.search || url.hash) throw new MediaError("媒体服务地址必须是无凭证、无查询参数的 HTTPS 地址。");
	if (!local && (typeof input.apiKey !== "string" || !input.apiKey.trim())) throw new MediaError("远程媒体服务需要独立 apiKey。");
	if (input.voice !== void 0 && (typeof input.voice !== "string" || !input.voice.trim())) throw new MediaError("语音音色配置无效。");
	return {
		baseUrl: input.baseUrl.replace(/\/+$/u, ""),
		apiKey: input.apiKey || "",
		model: input.model,
		voice: input.voice
	};
};
const imageProvider = (value) => {
	const base = provider(value, true);
	if (!base) return void 0;
	const raw = value;
	const size = raw.size ?? "1024x1024";
	const stylePrompt = raw.stylePrompt ?? "";
	const ownerOnly = raw.ownerOnly ?? false;
	if (typeof size !== "string" || !/^\d{2,4}x\d{2,4}$/u.test(size) || typeof stylePrompt !== "string" || stylePrompt.length > 2e3 || typeof ownerOnly !== "boolean") throw new MediaError("生图服务 size、stylePrompt 或 ownerOnly 配置无效。");
	return {
		...base,
		size,
		stylePrompt,
		ownerOnly
	};
};
const getMediaConfig = (value = getAppConfigValue()) => {
	const raw = value?.media ?? {};
	const config = {
		imageLibrary: imageLibrary(raw.imageLibrary),
		activeImage: raw.activeImage,
		voices: voiceLibrary(raw.voices),
		activeVoice: raw.activeVoice,
		localSpeech: localSpeechOptions(raw.localSpeech),
		allowedHosts: raw.allowedHosts ?? [],
		timeoutMs: raw.timeoutMs ?? 6e4,
		maxBytes: raw.maxBytes ?? 10485760,
		maxAttachments: raw.maxAttachments ?? 3,
		ttsMaxChars: raw.ttsMaxChars ?? 800,
		stickerRoot: raw.stickerRoot ?? defaultStickerRoot(),
		stickerMaxItems: raw.stickerMaxItems ?? 300,
		vision: provider(raw.vision),
		asr: provider(raw.asr, true),
		tts: provider(raw.tts, true),
		imageGen: imageProvider(raw.imageGen),
		speech: speechOptions(raw.speech)
	};
	if (!Array.isArray(config.allowedHosts) || config.allowedHosts.some((host) => typeof host !== "string" || !/^[a-z0-9.-]+$/u.test(host) || host.startsWith("."))) throw new MediaError("media.allowedHosts 必须是精确域名列表，不支持通配符。");
	for (const [number, min, max] of [
		[
			config.timeoutMs,
			1e3,
			12e4
		],
		[
			config.maxBytes,
			1024,
			26214400
		],
		[
			config.maxAttachments,
			1,
			5
		],
		[
			config.ttsMaxChars,
			1,
			4e3
		],
		[
			config.stickerMaxItems,
			1,
			500
		]
	]) if (!Number.isSafeInteger(number) || number < min || number > max) throw new MediaError("媒体大小、超时或次数配置超出范围。");
	if (config.stickerRoot !== void 0 && (typeof config.stickerRoot !== "string" || !config.stickerRoot.trim())) throw new MediaError("表情素材目录配置无效。");
	if (config.activeVoice !== void 0 && typeof config.activeVoice !== "string") throw new MediaError("音色ID无效。");
	selectVoice(config, true);
	if (config.activeImage !== void 0 && typeof config.activeImage !== "string") throw new MediaError("生图配置ID无效");
	if (config.activeImage) {
		const selected = config.imageLibrary?.find((item) => item.id === config.activeImage);
		if (!selected) throw new MediaError("所选生图配置不存在");
		config.imageGen = selected.enabled ? selected.provider : void 0;
	}
	return config;
};
const imageLibrary = (value) => {
	if (value === void 0) return [];
	if (!Array.isArray(value) || value.length > 100) throw new MediaError("生图库最多100项");
	const ids = /* @__PURE__ */ new Set();
	return value.map((item) => {
		if (!item || typeof item !== "object" || !/^[a-zA-Z0-9_-]{1,64}$/u.test(item.id) || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim() || item.name.length > 80 || typeof item.enabled !== "boolean") throw new MediaError("生图配置名称、ID或状态无效");
		ids.add(item.id);
		const parsed = imageProvider(item.provider);
		if (!parsed) throw new MediaError("需要生图服务配置");
		return {
			id: item.id,
			name: item.name.trim(),
			enabled: item.enabled,
			provider: parsed
		};
	});
};

export { MediaError, MediaUnavailableError, getMediaConfig, imageLibrary, unavailableMediaReply };