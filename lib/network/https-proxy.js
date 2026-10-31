import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

// src/network/https-proxy.ts
const validateHttpsProxy = (value) => {
	if (value === void 0) return void 0;
	if (value === "") return "";
	if (typeof value !== "string" || value.length > 2048) throw new Error("HTTPS_PROXY 必须是 HTTP/HTTPS 代理地址或空字符串");
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("HTTPS_PROXY 地址无效");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("HTTPS_PROXY 仅支持无账号密码、无路径的 HTTP/HTTPS 代理地址");
	return url.href;
};
let owned;
let previous;
let signature;
/** Native fetch shares Undici's dispatcher; leave pinned attachment downloads intact. */
const configureHttpsProxy = (config, env = process.env) => {
	const proxy = validateHttpsProxy(config.HTTPS_PROXY ?? env.HTTPS_PROXY);
	const noProxy = [
		"localhost",
		"127.0.0.1",
		"[::1]",
		env.NO_PROXY || env.no_proxy || ""
	].filter(Boolean).join(",");
	const nextSignature = proxy ? JSON.stringify([proxy, noProxy]) : void 0;
	if (signature === nextSignature) return;
	if (!proxy) {
		disposeHttpsProxy();
		return;
	}
	const next = new EnvHttpProxyAgent({
		httpsProxy: proxy,
		httpProxy: "",
		noProxy
	});
	const old = owned;
	if (!owned) previous = getGlobalDispatcher();
	setGlobalDispatcher(next);
	owned = next;
	signature = nextSignature;
	old?.close().catch(() => void 0);
};
const disposeHttpsProxy = () => {
	if (owned && previous && getGlobalDispatcher() === owned) setGlobalDispatcher(previous);
	const old = owned;
	owned = void 0;
	previous = void 0;
	signature = void 0;
	old?.close().catch(() => void 0);
};

export { configureHttpsProxy, disposeHttpsProxy, validateHttpsProxy };