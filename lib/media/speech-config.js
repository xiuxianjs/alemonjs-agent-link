// src/media/speech-config.ts
var SpeechError = class extends Error {
	stage;
	detail;
	constructor(stage, detail) {
		super(detail);
		this.stage = stage;
		this.detail = detail;
	}
};
const speechOptions = (value = {}, allowUnselectedFishVoice = false) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new SpeechError("configuration", "语音引擎配置无效。");
	const raw = value;
	const options = {
		engine: raw.engine ?? "auto",
		fallback: raw.fallback ?? true,
		systemVoice: raw.systemVoice,
		edgeVoice: raw.edgeVoice ?? "zh-CN-XiaoyiNeural",
		url: raw.url,
		apiKey: raw.apiKey,
		speaker: raw.speaker ?? "中文女",
		sampleRate: raw.sampleRate ?? 22050,
		referenceAudio: raw.referenceAudio,
		referenceText: raw.referenceText,
		language: raw.language ?? "zh",
		urlTemplate: raw.urlTemplate,
		voiceId: raw.voiceId,
		instruction: raw.instruction,
		model: raw.model
	};
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![
		"auto",
		"system",
		"edge",
		"openai",
		"fish",
		"breeze",
		"cosyvoice",
		"gptsovits",
		"http"
	].includes(options.engine) || typeof options.fallback !== "boolean" || !Number.isSafeInteger(options.sampleRate) || options.sampleRate < 8e3 || options.sampleRate > 48e3 || [
		options.systemVoice,
		options.edgeVoice,
		options.apiKey,
		options.speaker,
		options.referenceAudio,
		options.referenceText,
		options.language,
		options.voiceId,
		options.instruction,
		options.model
	].some((item) => item !== void 0 && (typeof item !== "string" || item.length > 2e3 || /[\r\n\0]/u.test(item))) || !options.edgeVoice || !options.language) throw new SpeechError("configuration", "语音引擎配置无效。");
	if (options.url) speechUrl(options.url);
	if (options.urlTemplate) {
		if (typeof options.urlTemplate !== "string" || !options.urlTemplate.includes("{text}")) throw new SpeechError("configuration", "HTTP 语音模板需要 {text}。");
		speechUrl(options.urlTemplate.replaceAll("{text}", "test"), true);
	}
	if (["cosyvoice", "gptsovits"].includes(options.engine) && !options.url) throw new SpeechError("configuration", "自建语音引擎需要 url。");
	if (options.engine === "gptsovits" && !options.referenceAudio) throw new SpeechError("configuration", "GPT-SoVITS 需要 referenceAudio。");
	if (options.engine === "http" && !options.urlTemplate) throw new SpeechError("configuration", "HTTP 语音引擎需要 urlTemplate。");
	if (options.engine === "fish" && (!options.url || !options.apiKey || !allowUnselectedFishVoice && !options.voiceId || !options.model)) throw new SpeechError("configuration", "Fish Audio 需要 url、apiKey、voiceId 和 model。");
	if (options.engine === "breeze" && (!options.url || !options.apiKey || !options.voiceId)) throw new SpeechError("configuration", "Breeze 语音引擎需要 url、apiKey 和 voiceId。");
	return options;
};
const speechUrl = (value, query = false) => {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new SpeechError("configuration", "语音服务地址无效。");
	}
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || !query && url.search || url.protocol === "http:" && ![
		"127.0.0.1",
		"localhost",
		"[::1]"
	].includes(url.hostname)) throw new SpeechError("configuration", "语音服务需要 HTTPS；本机回环服务允许 HTTP，凭证请使用独立字段。");
	return url;
};

export { SpeechError, speechOptions, speechUrl };