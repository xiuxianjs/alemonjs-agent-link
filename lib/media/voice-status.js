import { templateBalance } from "../model-pool/balance.js";
import { createHash } from "node:crypto";

// src/media/voice-status.ts
const balances = /* @__PURE__ */ new Map();
const pending = /* @__PURE__ */ new Map();
const voiceAccountKey = (config, voice) => {
	const speech = voice?.speech || config.speech;
	const openai = speech?.engine === "openai" || speech?.engine === "auto";
	return createHash("sha256").update(JSON.stringify([
		openai ? config.tts?.baseUrl : speech?.url,
		openai ? config.tts?.apiKey : speech?.apiKey,
		voice?.balanceUrl
	])).digest("hex");
};
const cachedVoiceBalance = (config, voice) => balances.get(voiceAccountKey(config, voice));
const voiceBalanceExhausted = (config) => {
	const voice = config.voices?.find((item) => item.id === config.activeVoice);
	const balance = voice && cachedVoiceBalance(config, voice);
	return Boolean(balance && Date.now() - balance.checkedAt < 6e4 && balance.status === "exhausted");
};
const fetchVoiceBalance = async (config, voice, force = false) => {
	const key = voiceAccountKey(config, voice);
	const cached = balances.get(key);
	if (!force && cached && Date.now() - cached.checkedAt < 6e4) return cached;
	if (pending.has(key)) return pending.get(key);
	const job = (async () => {
		let result;
		const engine = voice.speech.engine;
		if (engine === "system" || engine === "edge") result = {
			text: "无供应商余额接口",
			status: "unsupported",
			checkedAt: Date.now()
		};
		else if (!voice.balanceUrl) result = {
			text: "未配置额度查询接口",
			status: "unsupported",
			checkedAt: Date.now()
		};
		else try {
			const apiKey = engine === "openai" || engine === "auto" ? config.tts?.apiKey : voice.speech.apiKey;
			if (!apiKey) throw new Error("未配置凭证");
			result = await templateBalance({ apiKey }, voice.balanceUrl, AbortSignal.timeout(6e3)) || {
				text: "未知额度",
				status: "unknown",
				checkedAt: Date.now()
			};
		} catch {
			result = {
				text: "查询失败",
				status: "failed",
				checkedAt: Date.now()
			};
		}
		if (balances.size >= 1e3) balances.clear();
		balances.set(key, result);
		return result;
	})().finally(() => pending.delete(key));
	pending.set(key, job);
	return await job;
};

export { cachedVoiceBalance, fetchVoiceBalance, voiceAccountKey, voiceBalanceExhausted };