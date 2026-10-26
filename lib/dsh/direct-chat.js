import { readCompletionStream } from "./completion-stream.js";
import { MAX_IMAGE_REQUEST_BYTES, inputText, modelContent } from "./input.js";
import { SessionRegistry } from "../state/registry.js";

// src/dsh/direct-chat.ts
const directChat = async (config, credentials, message, signal, onEvent, privateHistory, onCompleted) => {
	if (!credentials) throw new Error("纯聊天需要配置模型 API Key。");
	const base = credentials.baseUrl || (config.provider === "deepseek-official" ? "https://api.deepseek.com" : "");
	const url = new URL(`${base.replace(/\/+$/, "")}/chat/completions`);
	if (url.protocol !== "https:" || url.username || url.password) throw new Error("模型服务需要有效的 HTTPS 地址。");
	if (config.inputBlockedKeywords.some((word) => word && inputText(message).includes(word))) throw new Error("请求被输入策略拒绝。");
	const registry = privateHistory ? new SessionRegistry(config) : void 0;
	const history = privateHistory ? await registry.privateHistory(privateHistory) : [];
	const body = JSON.stringify({
		model: credentials.model || config.model,
		stream: !config.outputBlockedKeywords.length,
		messages: [
			{
				role: "system",
				content: `${config.defaultSystemPrompt}\n当前为纯聊天降级模式，没有网页、文件或终端工具。不要声称已执行工具或读取本地文件。`
			},
			...privateHistory?.memoryContext ? [{
				role: "user",
				content: privateHistory.memoryContext
			}] : [],
			...history,
			{
				role: "user",
				content: modelContent(message)
			}
		]
	});
	if (Buffer.byteLength(body) > (typeof message === "string" ? config.maxRequestBytes : 50331648)) throw new Error("请求超过大小限制。");
	const response = await fetch(url, {
		method: "POST",
		redirect: "error",
		signal,
		headers: {
			Authorization: `Bearer ${credentials.apiKey}`,
			"Content-Type": "application/json"
		},
		body
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`模型服务返回 HTTP ${response.status}。`);
	}
	if (!response.body) throw new Error("模型响应为空。");
	let answer;
	const streamed = !config.outputBlockedKeywords.length && response.headers.get("content-type")?.includes("text/event-stream");
	if (streamed) answer = (await readCompletionStream(response, config.maxRequestBytes, signal, async (content) => {
		await onEvent({
			type: "content",
			content
		});
	})).content || "";
	else {
		const reader = response.body.getReader();
		const chunks = [];
		let bytes = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > config.maxRequestBytes) throw new Error("模型响应超过大小限制。");
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		let payload;
		try {
			payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("模型响应不是有效 JSON。");
		}
		answer = payload?.choices?.[0]?.message?.content;
	}
	if (typeof answer !== "string" || !answer.trim()) throw new Error("模型未返回文本回复。");
	signal.throwIfAborted();
	const content = config.outputBlockedKeywords.some((word) => word && answer.includes(word)) ? "回复因内容安全策略未发送。" : answer;
	if (!streamed) await onEvent({
		type: "content",
		content
	});
	await onEvent({ type: "done" });
	signal.throwIfAborted();
	await onCompleted?.(signal);
	signal.throwIfAborted();
	if (privateHistory) await registry.appendPrivateTurn(privateHistory, inputText(message) + (typeof message === "string" ? "" : "\n[本轮包含图片]"), content);
};

export { directChat };