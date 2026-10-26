import { DSHError, abortFailure } from "./errors.js";
import { reserveWorkspaceText } from "../billing/budget.js";
import { getDSHConfig } from "./runtime-config.js";
import { withToolUsePolicy } from "../agent/tool-use-policy.js";
import { inputText, withInputContext } from "./input.js";
import { ensureDSHSupervisor, getDSHBridge, hasDSHBridgeOverride } from "./supervisor.js";

// src/dsh/client.ts
const toCapabilities = (value) => ({
	chat: value.chat,
	web: value.web,
	files: value.files,
	terminal: value.terminal
});
const getHeaders = (token) => {
	const headers = {
		Accept: "text/event-stream",
		"Content-Type": "application/json"
	};
	headers.Authorization = `Bearer ${token}`;
	return headers;
};
const parseSSEMessage = (rawEvent) => {
	const data = rawEvent.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
	if (!data) return null;
	try {
		const event = JSON.parse(data);
		if (!event || typeof event.type !== "string" || event.type === "content" && typeof event.content !== "string") throw new Error("missing type");
		return event;
	} catch {
		throw new DSHError("protocol", "DSH 返回了无效的流式数据");
	}
};
const consumeEvents = async (reader, onEvent) => {
	const decoder = new TextDecoder();
	let buffer = "";
	const dispatch = async (rawEvent) => {
		const event = parseSSEMessage(rawEvent);
		if (!event) return;
		if (event.type === "error") {
			const message = event.message || "DSH Agent 执行失败";
			throw new DSHError(/timed out|超时/i.test(message) ? "timeout" : "agent", message);
		}
		await onEvent(event);
	};
	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
		let separator = buffer.indexOf("\n\n");
		while (separator >= 0) {
			await dispatch(buffer.slice(0, separator));
			buffer = buffer.slice(separator + 2);
			separator = buffer.indexOf("\n\n");
		}
		if (done) break;
	}
	if (buffer.trim()) await dispatch(buffer);
};
const streamChat = async (config, sessionId, message, onEvent, userId = "unknown", externalSignal, capabilities = {
	chat: true,
	web: true,
	files: false,
	terminal: false
}, privateHistory, onCompleted, framework) => {
	config = {
		...config,
		defaultSystemPrompt: withToolUsePolicy(config.defaultSystemPrompt)
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	timeout.unref();
	try {
		const supervisor = await ensureDSHSupervisor(config);
		if (!capabilities.chat) throw new DSHError("auth", "聊天能力已关闭。");
		const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
		if (!hasDSHBridgeOverride()) {
			await supervisor.prepareForChat();
			signal.throwIfAborted();
			if (!supervisor.useSandbox(sessionId)) {
				await supervisor.chatDirect(message, signal, onEvent, privateHistory, onCompleted);
				return;
			}
		}
		const bridge = await getDSHBridge();
		const settleText = await reserveWorkspaceText(config, `${config.defaultSystemPrompt}\n${inputText(message)}\n${privateHistory?.memoryContext || ""}`);
		let budgetText = "";
		signal.throwIfAborted();
		const response = await fetch(`${bridge.url}/v1/chat`, {
			method: "POST",
			headers: {
				...getHeaders(bridge.token),
				"X-Agent-Link-User": userId
			},
			body: JSON.stringify({
				sessionId,
				message: withInputContext(message, privateHistory?.memoryContext || ""),
				systemPrompt: config.defaultSystemPrompt,
				stream: true,
				capabilities: toCapabilities(capabilities),
				...framework ? { framework } : {}
			}),
			signal: externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal
		});
		if (response.status === 401 || response.status === 403) throw new DSHError("auth", "DSH 鉴权失败");
		if (!response.ok) throw new DSHError("http", `DSH 服务返回 HTTP ${response.status}`);
		if (!response.headers.get("content-type")?.includes("text/event-stream")) throw new DSHError("protocol", "DSH 未返回 SSE 响应");
		if (!response.body) throw new DSHError("protocol", "DSH 未返回流式响应");
		await consumeEvents(response.body.getReader(), async (event) => {
			if (event.type === "content") budgetText += event.content;
			if (Buffer.byteLength(budgetText) > config.maxRequestBytes) throw new DSHError("protocol", "工作区回复超过大小限制。");
			await onEvent(event);
		});
		await settleText(budgetText);
		signal.throwIfAborted();
		await onCompleted?.(signal);
		signal.throwIfAborted();
	} catch (error) {
		if (externalSignal?.aborted || error instanceof Error && error.name === "TimeoutError") throw abortFailure(error, externalSignal) ?? error;
		if (error instanceof DSHError) throw error;
		if (error instanceof DOMException && error.name === "AbortError") {
			if (externalSignal?.aborted) throw new DSHError("cancelled", "DSH 请求已取消");
			throw new DSHError("timeout", "DSH 请求超时");
		}
		throw new DSHError("network", error instanceof Error ? error.message : "无法连接 DSH 服务");
	} finally {
		clearTimeout(timeout);
	}
};
const clearSession = async (config, sessionId) => {
	await deleteBridgeResource(config, `/v1/session/${encodeURIComponent(sessionId)}`, "无法清除 DSH 会话");
};
const deleteBridgeResource = async (config, path, failureMessage) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
	timeout.unref();
	try {
		const supervisor = await ensureDSHSupervisor(config);
		if (!hasDSHBridgeOverride()) {
			await supervisor.prepareForChat();
			if (supervisor.status().phase !== "ready") {
				if (path.startsWith("/v1/session/")) {
					const session = decodeURIComponent(path.slice(12));
					supervisor.queueSessionReset(session);
					supervisor.resetTransport(session);
					return;
				}
				throw new DSHError("http", "纯聊天模式无法删除旧沙箱数据；请恢复 Bridge 后重试清理。");
			}
		}
		if (path.startsWith("/v1/session/")) supervisor.resetTransport(decodeURIComponent(path.slice(12)));
		const bridge = await getDSHBridge();
		const response = await fetch(`${bridge.url}${path}`, {
			method: "DELETE",
			headers: getHeaders(bridge.token),
			signal: controller.signal
		});
		if (response.status === 401 || response.status === 403) throw new DSHError("auth", "DSH 鉴权失败");
		if (!response.ok) throw new DSHError("http", failureMessage);
	} catch (error) {
		if (error instanceof DSHError) throw error;
		if (error instanceof DOMException && error.name === "AbortError") throw new DSHError("timeout", "DSH 请求超时");
		throw new DSHError("network", error instanceof Error ? error.message : "无法连接 DSH 服务");
	} finally {
		clearTimeout(timeout);
	}
};
const purgeSessionData = async (config, sessionId) => {
	await deleteBridgeResource(config, `/v1/group/${encodeURIComponent(sessionId)}`, "无法清除 DSH 群数据");
};
const purgeGroupHashData = async (config, groupHash) => {
	await deleteBridgeResource(config, `/v1/group-hash/${encodeURIComponent(groupHash)}`, "无法清除 DSH 群数据");
};
const toUserMessage = (error) => {
	if (!(error instanceof DSHError)) return "服务暂时不可用，请稍后再试。";
	const publicErrors = {
		"额度统计暂时不可用，已暂停付费调用，请联系主人检查 Redis。": "额度暂时不可用，请稍后重试或联系机器人主人。",
		"当前服务商尚未配置可核验的价格，已暂停付费调用。": "当前服务暂不可用，请联系机器人主人检查配置。",
		"当前模型尚未配置可核验的价格，已暂停付费调用。": "当前模型暂不可用，请联系机器人主人检查配置。",
		"DSH 初始化失败，自动恢复后仍不可用，请检查本地运行环境。": "服务暂时不可用，请联系机器人主人。",
		"DSH 沙箱目录访问失败，请重启服务并检查运行环境。": "服务暂时不可用，请联系机器人主人。"
	};
	if (Object.hasOwn(publicErrors, error.message)) return publicErrors[error.message];
	if (error.kind === "budget" || error.kind === "media" || error.kind === "agent" && [
		"DSH 初始化失败，自动恢复后仍不可用，请检查本地运行环境。",
		"图片无法解码，请重新发送 PNG、JPEG、WebP 或 GIF 图片。",
		"DSH 沙箱目录访问失败，请重启服务并检查运行环境。"
	].includes(error.message)) return error.message;
	return {
		budget: "今日额度不足，请联系机器人主人充值或增加今日额度，也可等待北京时间零点刷新。",
		media: "媒体处理失败，请改用文字。",
		delivery: "回复发送失败，请稍后重试。",
		auth: "Agent 服务认证失败，请联系机器人管理员。",
		http: "Agent 服务暂时不可用，请稍后再试。",
		network: "暂时无法连接 Agent 服务，请稍后再试。",
		timeout: "Agent 响应超时，请稍后重试。",
		cancelled: "本次回复已取消。",
		protocol: "Agent 服务响应异常，请联系机器人管理员。",
		agent: "Agent 本轮执行失败。请稍后重试；若持续失败，请由主人检查模型配置和运行环境。",
		migration: "会话正在初始化，请稍后重试。"
	}[error.kind];
};

export { DSHError, clearSession, getDSHConfig, purgeGroupHashData, purgeSessionData, streamChat, toUserMessage };