import { publicPageUrl } from "../proactive/public-web.js";

// src/media/links.ts
/** Classify syntax only: a URL suffix is not evidence of fetched media content. */
const inspectLinks = (text) => {
	const links = [];
	for (const match of text.slice(0, 16e3).matchAll(/https?:\/\/[^\s<>"'，。！？；、）】]+/giu)) {
		let raw = match[0].replace(/[.,;!?）\]}>]+$/u, "");
		while (raw.endsWith(")") && (raw.match(/\)/gu)?.length || 0) > (raw.match(/\(/gu)?.length || 0)) raw = raw.slice(0, -1);
		let url;
		try {
			url = new URL(raw);
		} catch {
			continue;
		}
		if (url.username || url.password) continue;
		if (links.some((link) => link.url === url.href)) continue;
		const kind = /(^|\.)bilibili\.com$/iu.test(url.hostname) || url.hostname === "b23.tv" ? "bilibili" : /\.(png|jpe?g|webp|gif)$/iu.test(url.pathname) ? "image" : /\.(mp4|webm|mov)$/iu.test(url.pathname) ? "video" : /\.(mp3|wav|m4a|ogg)$/iu.test(url.pathname) ? "audio" : "webpage";
		let readable = true;
		try {
			publicPageUrl(url.href);
		} catch {
			readable = false;
		}
		links.push({
			url: url.href,
			kind,
			readable
		});
		if (links.length === 10) break;
	}
	return {
		links,
		evidence: "仅识别链接格式和文件后缀，未访问页面或识别媒体。readable 仅表示 URL 规则通过，下载时仍校验公网地址。"
	};
};

export { inspectLinks };