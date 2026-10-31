import { SpeechError, speechOptions } from "./speech-config.js";
import { localSpeechOptions } from "./local-speech.js";
import { selectVoice } from "./voice-library.js";
import { MediaHttpError, readBounded } from "./http.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { BudgetExceededError, assertBudgetAvailable } from "../billing/budget.js";
import { audioFormat } from "./download.js";
import { requestSpeechAudio } from "./providers.js";
import { voiceBalanceExhausted } from "./voice-status.js";
import { speechProcess } from "./speech-process.js";
import { dirname, join } from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

// src/media/speech.ts
const quotaCooldowns = /* @__PURE__ */ new Map();
const exists = (path) => access(path).then(() => true, () => false);
const edgePython = (config) => join(dirname(config.workspaceRoot), "speech-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const edgeInstalled = (config) => exists(edgePython(config));
const pcmWave = (pcm, sampleRate) => {
	if (!pcm.length || pcm.length % 2) throw new SpeechError("format", "PCM 音频长度无效。");
	const header = Buffer.alloc(44);
	header.write("RIFF");
	header.writeUInt32LE(pcm.length + 36, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
};
const validateSpeechAudio = (data, maxBytes) => {
	const format = audioFormat(data)?.extension;
	if (!data.length || data.length > maxBytes || ![
		"mp3",
		"wav",
		"ogg"
	].includes(format)) throw new SpeechError("format", "语音引擎未返回有效的 MP3、WAV 或 OGG 音频。");
	return format;
};
const systemSpeech = async (text, file, config, signal) => {
	const voice = config.speech?.systemVoice;
	if (process.platform === "darwin") {
		let selected = voice;
		if (!selected && /[\u3400-\u9fff]/u.test(text)) {
			const voices = await speechProcess("/usr/bin/say", ["-v", "?"], signal);
			selected = voices.match(/^(Tingting.*?)\s+zh_CN\s/mu)?.[1]?.trim() || voices.match(/^(.*?)\s+zh_CN\s/mu)?.[1]?.trim();
		}
		await speechProcess("/usr/bin/say", [
			"-f",
			"-",
			"-o",
			file,
			"--file-format=WAVE",
			"--data-format=LEI16@22050",
			...selected ? ["-v", selected] : []
		], signal, text);
	} else if (process.platform === "win32") await speechProcess("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(`[Console]::InputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;try{if($env:SPEECH_VOICE){$s.SelectVoice($env:SPEECH_VOICE)}else{$v=$s.GetInstalledVoices()|Where-Object{$_.VoiceInfo.Culture.Name -eq 'zh-CN'}|Select-Object -First 1;if($v){$s.SelectVoice($v.VoiceInfo.Name)}};$s.SetOutputToWaveFile($env:SPEECH_OUTPUT);$s.Speak([Console]::In.ReadToEnd())}finally{$s.Dispose()}`, "utf16le").toString("base64")
	], signal, text, {
		SPEECH_OUTPUT: file,
		SPEECH_VOICE: voice || ""
	});
	else try {
		await speechProcess("espeak-ng", [
			"--stdin",
			"-v",
			voice || "cmn",
			"-w",
			file
		], signal, text);
	} catch {
		signal.throwIfAborted();
		await speechProcess("espeak", [
			"--stdin",
			"-v",
			voice || "zh",
			"-w",
			file
		], signal, text);
	}
};
const remoteSpeech = async (engine, text, config, signal) => {
	const options = speechOptions(config.speech);
	let url, body, method = "POST";
	let headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
	if (engine === "fish") {
		url = `${options.url.replace(/\/+$/u, "")}/v1/tts`;
		headers = {
			...headers,
			"Content-Type": "application/json",
			model: options.model
		};
		body = JSON.stringify({
			text,
			reference_id: options.voiceId,
			format: "mp3"
		});
	} else if (engine === "breeze") {
		url = `${options.url.replace(/\/+$/u, "")}/v1/text-to-speech/${encodeURIComponent(options.voiceId)}?output_format=mp3`;
		headers = {
			...headers,
			"xi-api-key": options.apiKey,
			"Content-Type": "application/json"
		};
		body = JSON.stringify({
			text,
			model_id: options.model,
			language_code: options.language,
			instructions: options.instruction
		});
	} else if (engine === "cosyvoice") {
		url = `${options.url.replace(/\/+$/u, "")}/inference_sft`;
		const form = new FormData();
		form.set("tts_text", text);
		form.set("spk_id", options.speaker);
		body = form;
	} else if (engine === "gptsovits") {
		url = `${options.url.replace(/\/+$/u, "")}/tts`;
		headers = {
			...headers,
			"Content-Type": "application/json"
		};
		body = JSON.stringify({
			text,
			text_lang: options.language,
			ref_audio_path: options.referenceAudio,
			prompt_text: options.referenceText || "",
			prompt_lang: options.language,
			media_type: "wav",
			streaming_mode: false
		});
	} else {
		url = options.urlTemplate.replaceAll("{text}", encodeURIComponent(text));
		method = "GET";
	}
	await assertBudgetAvailable(getDSHConfig());
	const response = await fetch(url, {
		method,
		headers,
		body,
		signal,
		redirect: "error"
	});
	const data = await readBounded(response, config.maxBytes);
	if (/json|text\/|html/iu.test(response.headers.get("content-type") || "")) throw new SpeechError("format", "语音服务返回了文本，未生成音频。");
	return engine === "cosyvoice" && !audioFormat(data) ? pcmWave(data, options.sampleRate) : data;
};
const renderSingleSpeech = async (text, config, signal, runtime = getDSHConfig(), services = {}) => {
	signal.throwIfAborted();
	if (!text.trim() || Array.from(text).length > config.ttsMaxChars) throw new SpeechError("configuration", `语音文本需要1–${config.ttsMaxChars}字符。`);
	config = selectVoice(config);
	const options = speechOptions(config.speech);
	const local = localSpeechOptions(config.localSpeech);
	const allowLocalFallback = local.enabled && local.fallback && options.fallback;
	if (options.engine === "system" && !local.enabled) throw new SpeechError("configuration", "本地音色已关闭。");
	if (local.voice) options.systemVoice = local.voice;
	const quotaKey = JSON.stringify([
		options.engine,
		options.url,
		options.apiKey,
		config.tts?.baseUrl,
		config.tts?.apiKey
	]);
	let quotaBlocked = voiceBalanceExhausted(config) || (quotaCooldowns.get(quotaKey) || 0) > Date.now();
	try {
		await assertBudgetAvailable(runtime);
	} catch (error) {
		if (!(error instanceof BudgetExceededError)) throw error;
		quotaBlocked = true;
	}
	const engines = options.engine === "auto" ? [
		...config.tts ? ["openai"] : [],
		"edge",
		"system"
	] : [options.engine];
	if (options.engine === "auto" && !options.fallback) engines.splice(0, engines.length, config.tts ? "openai" : await edgeInstalled(runtime) ? "edge" : "system");
	if (options.engine !== "auto" && options.fallback) {
		for (const fallback of ["edge", "system"]) if (!engines.includes(fallback)) engines.push(fallback);
	}
	for (let i = engines.length - 1; i >= 0; i--) if (engines[i] === "system" && (!local.enabled || options.engine !== "system" && !allowLocalFallback)) engines.splice(i, 1);
	if (quotaBlocked && options.engine !== "system") {
		if (!allowLocalFallback) throw new SpeechError("engine", "语音额度不足，且未启用降级。");
		engines.splice(0, engines.length, "system");
	}
	if (!engines.length) throw new SpeechError("configuration", "没有启用的可用语音引擎。");
	const root = join(dirname(runtime.workspaceRoot), "speech-cache");
	await mkdir(root, {
		recursive: true,
		mode: 448
	});
	const temp = await mkdtemp(join(root, "job-"));
	const failures = [];
	let lastStage = "engine";
	let lastReason = "引擎执行失败";
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
	try {
		for (const engine of engines) {
			signal.throwIfAborted();
			deadline.throwIfAborted();
			const attempt = AbortSignal.any([deadline, AbortSignal.timeout(options.fallback ? Math.max(1e3, config.timeoutMs - 5e3) : config.timeoutMs)]);
			try {
				let data;
				if (engine === "openai") data = await requestSpeechAudio(text, config, attempt);
				else if ([
					"fish",
					"breeze",
					"cosyvoice",
					"gptsovits",
					"http"
				].includes(engine)) data = await remoteSpeech(engine, text, config, attempt);
				else {
					const file = join(temp, engine === "edge" ? "speech.mp3" : "speech.wav");
					if (engine === "edge") {
						if (!await edgeInstalled(runtime)) throw new SpeechError("configuration", "edge-tts 尚未安装。");
						const input = join(temp, "input.txt");
						await writeFile(input, text, { mode: 384 });
						await (services.run || speechProcess)(edgePython(runtime), [
							"-I",
							"-m",
							"edge_tts",
							"--voice",
							options.edgeVoice,
							"--file",
							input,
							"--write-media",
							file
						], attempt);
					} else await (services.system || systemSpeech)(text, file, {
						...config,
						speech: options
					}, attempt);
					if ((await stat(file)).size > config.maxBytes) throw new SpeechError("format", "语音文件超过大小限制。");
					data = await readFile(file);
				}
				attempt.throwIfAborted();
				return {
					data,
					extension: validateSpeechAudio(data, config.maxBytes),
					engine,
					text,
					fallbackFrom: failures
				};
			} catch (error) {
				signal.throwIfAborted();
				lastStage = error instanceof SpeechError ? error.stage : attempt.aborted ? "timeout" : "engine";
				const networkCode = error?.cause?.code;
				lastReason = networkCode === "UND_ERR_CONNECT_TIMEOUT" ? "连接语音服务超时，请检查运行机器到供应商的网络" : networkCode === "ENOTFOUND" || networkCode === "EAI_AGAIN" ? "语音服务域名解析失败" : error instanceof MediaHttpError ? `供应商返回 HTTP ${error.status}` : attempt.aborted ? "请求超时" : error instanceof SpeechError ? error.detail : "连接或引擎执行失败";
				failures.push(engine);
				if (error instanceof BudgetExceededError || error instanceof MediaHttpError && error.status === 402) {
					if (error instanceof MediaHttpError) {
						for (const [key, until] of quotaCooldowns) if (until <= Date.now()) quotaCooldowns.delete(key);
						if (quotaCooldowns.size >= 1e3) quotaCooldowns.clear();
						quotaCooldowns.set(quotaKey, Date.now() + 3e5);
					}
					if (allowLocalFallback && engine !== "system") engines.splice(engines.indexOf(engine) + 1, engines.length, "system");
				}
			}
		}
		throw new SpeechError(deadline.aborted ? "timeout" : lastStage, `语音合成未完成（${failures.join("、")}）：${lastReason}。`);
	} catch (error) {
		signal.throwIfAborted();
		if (deadline.aborted) throw new SpeechError("timeout", "语音合成超时。");
		throw error;
	} finally {
		await rm(temp, {
			recursive: true,
			force: true
		});
	}
};
/** Explicit rotation uses library order; individual previews disable it. */
const renderSpeech = async (text, config, signal, runtime = getDSHConfig(), services = {}) => {
	if (!config.voiceRotation) return renderSingleSpeech(text, config, signal, runtime, services);
	const local = localSpeechOptions(config.localSpeech);
	const candidates = (config.voices || []).filter((voice) => voice.enabled !== false && (voice.speech.engine !== "system" || local.enabled));
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
	const failures = [];
	const slots = candidates.length + (local.enabled && local.fallback ? 1 : 0);
	const attemptMs = Math.max(1, Math.floor(config.timeoutMs / Math.max(1, slots)));
	for (const voice of candidates) {
		deadline.throwIfAborted();
		const attempt = AbortSignal.any([deadline, AbortSignal.timeout(attemptMs)]);
		try {
			return {
				...await renderSingleSpeech(text, {
					...config,
					voiceRotation: false,
					activeVoice: voice.id,
					voices: config.voices.map((item) => item.id === voice.id ? {
						...item,
						speech: {
							...item.speech,
							fallback: false
						}
					} : item)
				}, attempt, runtime, services),
				fallbackFrom: failures
			};
		} catch (error) {
			deadline.throwIfAborted();
			if (!(error instanceof SpeechError) && !attempt.aborted) throw error;
			failures.push(voice.id);
			if (voice.speech.fallback === false) throw new SpeechError("engine", `音色 ${voice.name} 失败，已按设置停止轮转。`);
		}
	}
	if (local.enabled && local.fallback) return {
		...await renderSingleSpeech(text, {
			...config,
			voiceRotation: false,
			activeVoice: "",
			speech: {
				engine: "system",
				fallback: false
			}
		}, deadline, runtime, services),
		fallbackFrom: failures
	};
	throw new SpeechError("engine", "音色轮转已用尽，且未启用本机兜底。");
};
const speechStatus = async (runtime = getDSHConfig()) => {
	let edge = false;
	if (await edgeInstalled(runtime)) try {
		await speechProcess(edgePython(runtime), [
			"-I",
			"-c",
			"import edge_tts; print(\"ready\")"
		], AbortSignal.timeout(5e3));
		edge = true;
	} catch {}
	return {
		edge,
		system: process.platform === "darwin" ? "macOS say" : process.platform === "win32" ? "Windows System.Speech" : "espeak-ng / espeak（需安装）",
		engines: [
			"auto",
			"system",
			"edge",
			"openai",
			"fish",
			"breeze",
			"cosyvoice",
			"gptsovits",
			"http"
		]
	};
};
const installs = /* @__PURE__ */ new Map();
const installSpeech = (runtime = getDSHConfig(), callerSignal = new AbortController().signal) => {
	const python = edgePython(runtime);
	if (installs.has(python)) return installs.get(python);
	const job = (async () => {
		const root = dirname(runtime.workspaceRoot);
		const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(3e5)]);
		await mkdir(root, {
			recursive: true,
			mode: 448
		});
		if (!await exists(python)) {
			if (await exists(runtime.pythonExecutable)) await speechProcess(runtime.pythonExecutable, [
				"-m",
				"venv",
				join(root, "speech-venv")
			], signal);
			else if (process.platform === "win32") try {
				await speechProcess("py", [
					"-3",
					"-m",
					"venv",
					join(root, "speech-venv")
				], signal);
			} catch {
				signal.throwIfAborted();
				await speechProcess("python", [
					"-m",
					"venv",
					join(root, "speech-venv")
				], signal);
			}
			else await speechProcess("python3", [
				"-m",
				"venv",
				join(root, "speech-venv")
			], signal);
		}
		await speechProcess(python, [
			"-I",
			"-m",
			"pip",
			"install",
			"--disable-pip-version-check",
			"edge-tts>=7,<8"
		], signal);
		await speechProcess(python, [
			"-I",
			"-c",
			"import edge_tts"
		], signal);
	})().finally(() => {
		installs.delete(python);
	});
	installs.set(python, job);
	return job;
};

export { edgePython, installSpeech, pcmWave, renderSpeech, speechStatus, validateSpeechAudio };