import { MediaError } from "./config.js";
import { downloadAttachment, imageMime } from "./download.js";
import { assertBudgetAvailable } from "../billing/budget.js";
import { readBounded } from "./http.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import "./providers.js";

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
				size: provider.size,
				n: 1,
				response_format: "b64_json"
			})
		});
	} catch {
		signal.throwIfAborted();
		throw new MediaError(deadline.aborted ? "生图服务超时，结果未确认。" : "生图服务连接失败，结果未确认。");
	}
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
	signal.throwIfAborted();
	deadline.throwIfAborted();
	if (data.length > config.maxBytes || ![
		"image/png",
		"image/jpeg",
		"image/webp"
	].includes(imageMime(data) || "")) throw new MediaError("生图结果格式无效或超过大小限制。");
	return data;
};
const imageGenerationTool = (config, deliver) => ({
	name: "generate_image",
	description: "使用已配置的图片生成服务根据用户要求生成图片。调用前根据当前请求组织画面描述；每回合最多尝试一张。返回 created 只代表已生成，图片将在本轮回复阶段发送，不代表平台已送达。",
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
		const data = await generateImage(String(prompt), config, context.signal);
		context.signal.throwIfAborted();
		await deliver(data);
		return {
			ok: true,
			created: true,
			format: imageMime(data),
			delivery: "queued-for-this-reply"
		};
	}
});

export { generateImage, imageGenerationTool };