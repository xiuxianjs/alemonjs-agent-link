import { MediaError } from "./config.js";
import { readBounded } from "./http.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { assertBudgetAvailable } from "../billing/budget.js";
import { downloadAttachment, imageMime } from "./download.js";
import "./providers.js";
import { generateDshImage } from "./dsh-image-generation.js";

// src/media/image-generation.ts
const generateImage = async (prompt, config, signal) => {
	const provider = config.imageGen;
	if (!provider) throw new MediaError("尚未配置生图服务。");
	if (!prompt.trim() || Array.from(prompt).length > 4e3) throw new MediaError("生图描述需要 1–4000 字符。");
	signal.throwIfAborted();
	await assertBudgetAvailable(getDSHConfig());
	signal.throwIfAborted();
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
	let response;
	try {
		response = await fetch(`${provider.baseUrl}/images/generations`, {
			method: "POST",
			redirect: "error",
			signal: deadline,
			headers: {
				"Content-Type": "application/json",
				...provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}
			},
			body: JSON.stringify({
				model: provider.model,
				prompt: [provider.stylePrompt, prompt.trim()].filter(Boolean).join("，"),
				...provider.protocol === "siliconflow" ? { image_size: provider.size } : {
					size: provider.size,
					n: 1,
					...provider.responseFormat === "auto" ? {} : { response_format: provider.responseFormat || "b64_json" }
				}
			})
		});
	} catch {
		signal.throwIfAborted();
		throw new MediaError(deadline.aborted ? "生图服务超时，结果未确认。" : "生图服务连接失败，结果未确认。");
	}
	return readGeneratedImage(response, config, deadline);
};
const readGeneratedImage = async (response, config, deadline) => {
	const payload = await readBounded(response, Math.ceil(config.maxBytes * 4 / 3) + 131072);
	let entry;
	try {
		const parsed = JSON.parse(payload.toString("utf8"));
		entry = (parsed?.data || parsed?.images)?.[0];
	} catch {
		throw new MediaError("生图服务未返回有效 JSON。");
	}
	let data;
	if (typeof entry?.b64_json === "string") {
		const encoded = entry.b64_json;
		if (encoded.length > Math.ceil(config.maxBytes * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new MediaError("生图服务返回的图片编码无效或过大。");
		data = Buffer.from(encoded, "base64");
	} else if (typeof entry?.url === "string") data = await downloadAttachment(entry.url, config, deadline);
	else throw new MediaError("生图服务没有返回图片。");
	deadline.throwIfAborted();
	if (data.length > config.maxBytes || ![
		"image/png",
		"image/jpeg",
		"image/webp"
	].includes(imageMime(data) || "")) throw new MediaError("生图结果格式无效或超过大小限制。");
	return data;
};
/** The reference is submitted as image bytes; failures must never fall back to text-only generation. */
const editAppearanceImage = async (prompt, reference, config, signal) => {
	const provider = config.imageGen;
	if (!provider || provider.protocol === "siliconflow") throw new MediaError("当前生图配置未提供兼容的参考图编辑接口，请选择支持 /images/edits 的服务。");
	if (!prompt.trim() || Array.from(prompt).length > 2e3) throw new MediaError("装扮描述需要1–2000字");
	signal.throwIfAborted();
	await assertBudgetAvailable(getDSHConfig());
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
	const form = new FormData();
	form.set("model", provider.model);
	form.set("prompt", "保持参考图中同一人物的脸型、发色、眼睛、体型和物种特征，仅按用户要求调整装扮与场景。" + prompt.trim());
	form.set("image", new Blob([new Uint8Array(reference)], { type: "image/png" }), "reference.png");
	form.set("size", provider.size);
	form.set("n", "1");
	let response;
	try {
		response = await fetch(provider.baseUrl + "/images/edits", {
			method: "POST",
			redirect: "error",
			signal: deadline,
			headers: provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {},
			body: form
		});
	} catch {
		signal.throwIfAborted();
		throw new MediaError("参考图编辑未完成，请核对服务是否支持图片编辑；不会改用无参考图重画。");
	}
	return readGeneratedImage(response, config, deadline);
};
const imageGenerationTool = (config, deliver, fallback = generateDshImage) => ({
	name: "generate_image",
	description: "使用已配置的图片生成服务根据用户要求生成图片。调用前根据当前请求组织画面描述；每回合最多尝试一张。" + (config.dshImageFallback ? "服务失败后内部会尝试一次 DSH 生图插件；若工具仍失败，才考虑 draw_image 简单绘制。" : "") + "返回 created 只代表已生成，图片将在本轮回复阶段发送，不代表平台已送达。",
	parameters: {
		type: "object",
		properties: { prompt: {
			type: "string",
			minLength: 1,
			maxLength: 4e3
		} },
		required: ["prompt"],
		additionalProperties: false
	},
	available: (context) => !context.autonomous && Boolean(config.imageGen) && (!config.imageGen?.ownerOnly || context.owner),
	execute: async ({ prompt }, context) => {
		let data;
		let source = "provider";
		try {
			data = await generateImage(String(prompt), config, context.signal);
		} catch (error) {
			context.signal.throwIfAborted();
			if (!config.dshImageFallback || !(error instanceof MediaError)) throw error;
			data = await fallback(String(prompt), config, context.signal);
			source = "dsh-image-gen";
		}
		context.signal.throwIfAborted();
		await deliver(data);
		return {
			ok: true,
			created: true,
			source,
			format: imageMime(data),
			delivery: "queued-for-this-reply"
		};
	}
});

export { editAppearanceImage, generateImage, imageGenerationTool };