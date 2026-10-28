import { isAbsolute } from "node:path";

// src/onebot/config.ts
const numericId = (value) => {
	if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("平台编号必须精确。");
	const id = String(value ?? "");
	if (!/^[1-9]\d{0,15}$/u.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("平台编号无效。");
	return id;
};
const resolveOneBotConfig = (value) => {
	const raw = value?.onebot;
	if (!raw || typeof raw.url !== "string" || typeof raw.selfId !== "string") throw new Error("OneBot 需要配置 url 和字符串 selfId。");
	let url;
	try {
		url = new URL(raw.url);
	} catch {
		throw new Error("OneBot 地址无效。");
	}
	if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("OneBot 需要无凭证、无查询参数的 WebSocket 地址。");
	if (url.protocol === "ws:" && ![
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname)) throw new Error("远程 OneBot 必须使用 WSS。");
	if (raw.accessToken !== void 0 && (typeof raw.accessToken !== "string" || !raw.accessToken.trim() || /[\r\n]/u.test(raw.accessToken))) throw new Error("OneBot accessToken 无效。");
	if (![
		"localhost",
		"127.0.0.1",
		"[::1]"
	].includes(url.hostname) && !raw.accessToken) throw new Error("远程 OneBot 需要 accessToken。");
	const timeoutMs = raw.timeoutMs ?? 1e4;
	const maxPayloadBytes = raw.maxPayloadBytes ?? 8388608;
	if (raw.recordDirectory !== void 0 && (typeof raw.recordDirectory !== "string" || !isAbsolute(raw.recordDirectory) || /[\0\r\n]/u.test(raw.recordDirectory))) throw new Error("OneBot recordDirectory 必须是本机绝对目录。");
	if (raw.imageDirectory !== void 0 && (typeof raw.imageDirectory !== "string" || !isAbsolute(raw.imageDirectory) || /[\0\r\n]/u.test(raw.imageDirectory))) throw new Error("OneBot imageDirectory 必须是本机绝对目录。");
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 6e4 || !Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1024 || maxPayloadBytes > 33554432) throw new Error("OneBot 超时或消息大小限制无效。");
	return {
		url: url.toString(),
		selfId: numericId(raw.selfId),
		accessToken: raw.accessToken,
		timeoutMs,
		maxPayloadBytes,
		...raw.recordDirectory ? { recordDirectory: raw.recordDirectory } : {},
		...raw.imageDirectory ? { imageDirectory: raw.imageDirectory } : {}
	};
};

export { numericId, resolveOneBotConfig };