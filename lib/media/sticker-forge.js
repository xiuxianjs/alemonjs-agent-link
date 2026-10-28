import { MediaError } from "./config.js";
import { imageInfo } from "./image-info.js";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

// src/media/sticker-forge.ts
const MAX_SOURCE_BYTES = 6291456;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16e6;
const MAX_TEXT = 40;
const MIN_SIZE = 128;
const MAX_SIZE = 512;
const escapeXml = (value) => value.replace(/[&<>"']/gu, (char) => ({
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	"\"": "&quot;",
	"'": "&apos;"
})[char]);
const charUnits = (char) => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 1 : .55;
const textUnits = (text) => Array.from(text).reduce((sum, char) => sum + charUnits(char), 0);
const wrap = (text, maxUnits) => {
	const lines = [];
	let line = "";
	let used = 0;
	for (const char of text) {
		const units = charUnits(char);
		if (line && used + units > maxUnits) {
			lines.push(line.trim());
			line = "";
			used = 0;
			if (char === " ") continue;
		}
		line += char;
		used += units;
	}
	if (line.trim()) lines.push(line.trim());
	return lines;
};
const captionLayout = (text, size) => {
	const padding = Math.round(size * .06);
	const maxWidth = size - padding * 2;
	const start = Array.from(text).length <= 4 ? .22 : .16;
	for (let scale = start; scale >= .06; scale -= .01) {
		const fontSize = Math.max(10, Math.floor(size * scale));
		const maxUnits = maxWidth / fontSize;
		const lines = wrap(text, maxUnits);
		if (lines.length <= 3 && (lines.length === 1 || textUnits(lines[lines.length - 1]) >= maxUnits * .5)) return {
			fontSize,
			lines,
			padding
		};
	}
	const fontSize = Math.max(10, Math.floor(size * .06));
	const lines = wrap(text, maxWidth / fontSize).slice(0, 3);
	if (lines.length) {
		const last = Array.from(lines[lines.length - 1]);
		lines[lines.length - 1] = `${last.slice(0, -1).join("")}…`;
	}
	return {
		fontSize,
		lines,
		padding
	};
};
const stickerSvg = (source, mime, options = {}) => {
	if (![
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif"
	].includes(mime)) throw new MediaError("原图格式不支持。");
	const size = options.size ?? 300;
	if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) throw new MediaError(`表情尺寸需要为 ${MIN_SIZE}–${MAX_SIZE} 像素。`);
	const position = options.position ?? "bottom";
	const fit = options.fit ?? "cover";
	if (!["top", "bottom"].includes(position)) throw new MediaError("表情文字位置无效。");
	if (!["cover", "contain"].includes(fit)) throw new MediaError("表情裁切方式无效。");
	const rawText = typeof options.text === "string" ? options.text.replace(/\s+/gu, " ").trim() : "";
	if (Array.from(rawText).length > MAX_TEXT) throw new MediaError(`表情文字最多 ${MAX_TEXT} 个字符。`);
	const href = `data:${mime};base64,${source.toString("base64")}`;
	const preserve = fit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
	let caption = "";
	if (rawText) {
		const { fontSize, lines, padding } = captionLayout(rawText, size);
		const lineHeight = fontSize * 1.18;
		const stroke = Math.max(2, Math.round(fontSize * .12));
		const first = position === "bottom" ? size - padding - (lines.length - 1) * lineHeight : padding + fontSize * .9;
		caption = `<g font-family="'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif" font-weight="bold" font-size="${fontSize}" text-anchor="middle" stroke-linejoin="round">` + lines.map((line, index) => {
			const y = Math.round(first + index * lineHeight);
			const escaped = escapeXml(line);
			return `<text x="${size / 2}" y="${y}" fill="none" stroke="#000000" stroke-width="${stroke}">${escaped}</text><text x="${size / 2}" y="${y}" fill="#ffffff">${escaped}</text>`;
		}).join("") + "</g>";
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><image x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="${preserve}" href="${href}"/>` + caption + "</svg>";
};
const renderSvg = async (svg, size, signal) => {
	const modulePath = createRequire(import.meta.url).resolve("@resvg/resvg-js");
	const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {Resvg}=require(workerData.modulePath); parentPort.postMessage(new Resvg(workerData.svg,{font:{loadSystemFonts:true}}).render().asPng());`, {
		eval: true,
		execArgv: [],
		workerData: {
			svg,
			modulePath
		}
	});
	let timer;
	let abort;
	try {
		return await new Promise((resolve, reject) => {
			abort = () => reject(signal.reason || /* @__PURE__ */ new Error("表情制作已取消"));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			timer = setTimeout(() => reject(/* @__PURE__ */ new Error("表情制作超时")), 1e4);
			worker.once("error", () => reject(/* @__PURE__ */ new Error("表情渲染失败")));
			worker.once("exit", () => reject(/* @__PURE__ */ new Error("表情渲染进程退出")));
			worker.once("message", (data) => {
				const png = Buffer.from(data);
				if (png.length > 5242880 || !png.subarray(0, 8).equals(Buffer.from([
					137,
					80,
					78,
					71,
					13,
					10,
					26,
					10
				])) || png.length < 24 || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) reject(/* @__PURE__ */ new Error("表情渲染结果无效"));
				else resolve(png);
			});
		});
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		await worker.terminate();
	}
};
/** Turn an untrusted raster image into a square PNG sticker, optionally with outlined captions. */
const renderSticker = async (source, options, signal) => {
	signal.throwIfAborted();
	if (source.length > MAX_SOURCE_BYTES) throw new MediaError("原图超过 6 MiB，无法制作表情。");
	const info = imageInfo(source);
	if (!info) throw new MediaError("原图格式不支持，仅支持 PNG、JPEG、WebP、GIF。");
	if (!info.width || !info.height || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION || info.width * info.height > MAX_PIXELS) throw new MediaError("原图尺寸过大，无法制作表情。");
	const size = options.size ?? 300;
	const svg = stickerSvg(source, info.mime, {
		...options,
		size
	});
	signal.throwIfAborted();
	const data = await renderSvg(svg, size, signal);
	signal.throwIfAborted();
	return {
		data,
		animated: info.animated
	};
};

export { renderSticker, stickerSvg };