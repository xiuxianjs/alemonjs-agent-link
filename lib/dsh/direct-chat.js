import { localRequestFailure } from "./errors.js";
import { BudgetExceededError, budgetedFetch } from "../billing/budget.js";
import { MAX_IMAGE_REQUEST_BYTES, inputText, modelContent } from "./input.js";
import { containsPrivateOutput, privateOutputEvents, privateSafeOutput } from "./private-output.js";
import { currentTimeContext } from "./time-context.js";
import { providerImageError } from "./provider-error.js";
import { readCompletionStream } from "./completion-stream.js";
import { getBoundCredential } from "../credentials/scoped.js";
import { withToolUsePolicy } from "../agent/tool-use-policy.js";
import { SessionRegistry } from "../state/registry.js";
import { logger } from "alemonjs";
import { setTimeout } from "node:timers/promises";

// src/dsh/direct-chat.ts
const directChat = async (config, credentials, message, signal, sendEvent, privateHistory, onCompleted) => {
	const personal = await getBoundCredential();
	if (personal) credentials = {
		apiKey: personal.apiKey,
		baseUrl: "https://api.deepseek.com",
		scoped: true,
		personal: personal.scope.channelId.startsWith("private:")
	};
	if (!credentials) throw new Error("纯聊天需要配置模型 API Key。");
	const onEvent = privateOutputEvents(sendEvent, {
		config,
		credentials
	}, config.maxRequestBytes);
	if (containsPrivateOutput(inputText(message), {
		config,
		credentials
	})) throw new Error("消息包含敏感信息，已阻止提交给模型。");
	const registry = privateHistory ? new SessionRegistry(config) : void 0;
	const history = privateHistory ? await registry.privateHistory(privateHistory) : [];
	const maxBytes = typeof message === "string" ? config.maxRequestBytes : MAX_IMAGE_REQUEST_BYTES;
	let current = credentials;
	let response;
	for (;;) {
		const budgetMs = current.retryBudgetMs ?? 12e3;
		const startedAt = current.startedAt ?? Date.now();
		if (Date.now() - startedAt > budgetMs) throw new Error("模型请求重试超时。");
		const base = current.baseUrl || (config.provider === "deepseek-official" ? "https://api.deepseek.com" : "");
		const url = new URL(`${base.replace(/\/+$/, "")}/chat/completions`);
		if (url.protocol !== "https:" || url.username || url.password) throw new Error("模型服务需要有效的 HTTPS 地址。");
		if (config.inputBlockedKeywords.some((word) => word && inputText(message).includes(word))) throw new Error("请求被输入策略拒绝。");
		const body = JSON.stringify({
			model: current.model || config.model,
			stream: !config.outputBlockedKeywords.length,
			messages: [
				{
					role: "system",
					content: `${withToolUsePolicy(config.defaultSystemPrompt)}\n当前为纯聊天降级模式，没有网页、文件或终端工具。不要声称已执行工具或读取本地文件。`
				},
				...privateHistory?.memoryContext ? [{
					role: "user",
					content: privateHistory.memoryContext
				}] : [],
				...history,
				{
					role: "user",
					content: modelContent(message)
				},
				{
					role: "system",
					content: currentTimeContext()
				}
			]
		});
		if (containsPrivateOutput(body, {
			config,
			current
		})) throw new Error("模型上下文包含敏感信息，已阻止提交。");
		if (Buffer.byteLength(body) > maxBytes) throw new Error("请求超过大小限制。");
		try {
			response = await budgetedFetch(config, url, {
				onDispatch: current.markSent,
				personalKey: current.personal,
				scopedKey: current.scoped,
				pricing: current.pricing,
				method: "POST",
				redirect: "error",
				signal,
				headers: {
					Authorization: `Bearer ${current.apiKey}`,
					"Content-Type": "application/json"
				},
				body
			});
		} catch (error) {
			current.report?.({
				ok: false,
				errorKind: localRequestFailure(error) ? localRequestFailure(error) : signal.aborted ? "cancelled" : error instanceof Error && /timeout/i.test(error.name + error.message) ? "timeout" : "network"
			});
			if (error instanceof BudgetExceededError) throw error;
			signal.throwIfAborted();
			throw error;
		}
		if (!response.ok) {
			const status = response.status;
			let detail = "";
			let imageError;
			try {
				const payload = await response.json();
				imageError = providerImageError(status, JSON.stringify(payload));
				detail = (String(payload.error?.code || "") + " " + String(payload.error?.message || payload.message || "")).trim().slice(0, 500);
			} catch {}
			logger.warn({
				status,
				detail
			}, "Direct model provider rejected request");
			current.report?.({
				ok: false,
				status,
				detail,
				headers: response.headers
			});
			const next = ([
				401,
				402,
				403,
				429
			].includes(status) || status === 400 && /计费账户|余额不足|余额已|欠费|冻结|billing|insufficient|quota|frozen|credit/iu.test(detail)) && (current.attempt || 1) < (current.maxAttempts || 1) ? current.next?.() : null;
			if (!next || (current.attempt || 1) >= (current.maxAttempts || 1)) {
				if (imageError) throw imageError;
				throw new Error(`模型服务返回 HTTP ${status}${detail ? `：${detail}` : ""}。`);
			}
			current = next;
			try {
				if (current.retryJitterMs) await setTimeout(Math.random() * current.retryJitterMs);
				await onEvent({ type: "retrying" });
			} catch (error) {
				current.report?.({
					ok: false,
					errorKind: "cancelled"
				});
				throw error;
			}
			continue;
		}
		if (!response.body) {
			current.report?.({
				ok: false,
				status: response.status,
				errorKind: "invalid-response"
			});
			throw new Error("模型响应为空。");
		}
		break;
	}
	try {
		let answer;
		if (!config.outputBlockedKeywords.length && response.headers.get("content-type")?.includes("text/event-stream")) {
			const result = await readCompletionStream(response, config.maxRequestBytes, signal, async () => {});
			current.reportUsage?.(result.usage || {});
			answer = result.content || "";
		} else {
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
			current.reportUsage?.(payload?.usage || {});
			answer = payload?.choices?.[0]?.message?.content;
		}
		if (typeof answer !== "string" || !answer.trim()) throw new Error("模型未返回文本回复。");
		signal.throwIfAborted();
		current.report?.({
			ok: true,
			status: response.status,
			headers: response.headers
		});
		const content = config.outputBlockedKeywords.some((word) => word && answer.includes(word)) ? "回复因内容安全策略未发送。" : privateSafeOutput(answer, {
			config,
			current
		});
		await onEvent({
			type: "content",
			content
		});
		await onEvent({ type: "done" });
		signal.throwIfAborted();
		await onCompleted?.(signal);
		signal.throwIfAborted();
		if (privateHistory) await registry.appendPrivateTurn(privateHistory, inputText(message) + (typeof message === "string" ? "" : "\n[本轮包含图片]"), content);
	} catch (error) {
		current.report?.({
			ok: false,
			status: response.status,
			errorKind: signal.aborted ? "cancelled" : "invalid-response"
		});
		throw error;
	}
};

export { directChat };