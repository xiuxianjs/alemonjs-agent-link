import { speechOptions } from "./speech-config.js";
import { getAppConfigValue } from "alemonjs";
import { join, resolve } from "node:path";

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
		allowedHosts: raw.allowedHosts ?? [],
		timeoutMs: raw.timeoutMs ?? 6e4,
		maxBytes: raw.maxBytes ?? 10485760,
		maxAttachments: raw.maxAttachments ?? 3,
		ttsMaxChars: raw.ttsMaxChars ?? 800,
		stickerRoot: raw.stickerRoot ?? defaultStickerRoot(),
		stickerCooldownSeconds: raw.stickerCooldownSeconds ?? 30,
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
			config.stickerCooldownSeconds,
			0,
			3600
		],
		[
			config.stickerMaxItems,
			1,
			500
		]
	]) if (!Number.isSafeInteger(number) || number < min || number > max) throw new MediaError("媒体大小、超时或次数配置超出范围。");
	if (config.stickerRoot !== void 0 && (typeof config.stickerRoot !== "string" || !config.stickerRoot.trim())) throw new MediaError("表情素材目录配置无效。");
	return config;
};

export { MediaError, MediaUnavailableError, getMediaConfig, unavailableMediaReply };