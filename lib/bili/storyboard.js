import { cropPixels, visualCropRequest } from "./crop.js";
import { videoSampleTimes } from "./visual.js";
import { attachmentUrl, downloadAttachment } from "../media/download.js";
import sharp from "sharp";

// src/bili/storyboard.ts
const maxPixels = 33554432;
const storyboardUrl = (source) => {
	if (typeof source !== "string" || source.length > 4096) throw new Error("预览图地址无效。");
	const url = attachmentUrl(source.startsWith("//") ? `https:${source}` : source, []);
	if (url.hostname !== "hdslb.com" && !url.hostname.endsWith(".hdslb.com")) throw new Error("预览图来源不受支持。");
	return url;
};
/** Read only indexed preview tiles. Never invent timestamps or use the whole sheet as one frame. */
const extractStoryboardFrames = async (data, duration, media, signal, download = downloadAttachment, requestedTimes, cropRequest) => {
	signal.throwIfAborted();
	const crop = visualCropRequest(cropRequest);
	if (crop && !requestedTimes) throw new Error("局部预览读取需要指定采样位置。");
	videoSampleTimes(duration);
	const requested = requestedTimes === void 0 ? void 0 : videoSampleTimes(duration, requestedTimes);
	if (!data || typeof data !== "object") throw new Error("预览图索引无效。");
	const snapshot = data;
	const dimension = (value, max) => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("预览图尺寸无效。");
		return value;
	};
	const columns = dimension(snapshot.img_x_len, 20), rows = dimension(snapshot.img_y_len, 20);
	const width = dimension(snapshot.img_x_size, 1920), height = dimension(snapshot.img_y_size, 1080);
	if (columns * width * rows * height > maxPixels) throw new Error("预览拼图像素超限。");
	if (!Array.isArray(snapshot.image) || !snapshot.image.length || snapshot.image.length > 200) throw new Error("预览图列表无效。");
	const images = snapshot.image.map(storyboardUrl);
	const headers = {
		"User-Agent": "Mozilla/5.0",
		Referer: "https://www.bilibili.com/"
	};
	let downloadedBytes = 0;
	const fetchBytes = async (url, maxBytes) => {
		signal.throwIfAborted();
		const limit = Math.min(media.maxBytes, maxBytes, 33554432 - downloadedBytes);
		if (limit <= 0) throw new Error("预览图总下载超限。");
		const bytes = await download(url.toString(), {
			...media,
			allowedHosts: [url.hostname],
			maxBytes: limit
		}, signal, headers);
		signal.throwIfAborted();
		if (bytes.length > limit) throw new Error("预览图下载超限。");
		downloadedBytes += bytes.length;
		return bytes;
	};
	let indices = [];
	if (snapshot.index !== void 0 && !Array.isArray(snapshot.index)) throw new Error("预览时间索引无效。");
	if (Array.isArray(snapshot.index)) indices = snapshot.index;
	if (!indices.length) {
		const bytes = await fetchBytes(storyboardUrl(snapshot.pvdata), 4e4);
		if (!bytes.length || bytes.length % 2) throw new Error("预览时间索引无效。");
		indices = Array.from({ length: bytes.length / 2 }, (_, index) => bytes.readUInt16BE(index * 2));
	}
	if (!indices.length || indices.length > 2e4 || indices.length > images.length * columns * rows) throw new Error("预览时间索引超限。");
	const raw = indices.map((item) => item && typeof item === "object" ? item.timestamp : item);
	if (raw.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0)) throw new Error("预览时间索引无效。");
	const values = raw;
	const scale = Math.max(...values) > duration * 1.5 ? 1e3 : 1;
	const entries = values.map((time, index) => ({
		seconds: time / scale,
		index
	}));
	if (entries.some((entry, index) => entry.seconds > duration || index > 0 && entry.seconds < entries[index - 1].seconds)) throw new Error("预览时间范围无效。");
	const end = entries.at(-1).seconds;
	const selected = /* @__PURE__ */ new Map();
	for (const target of requested || (end > 0 ? videoSampleTimes(end, void 0, 9) : [0])) {
		const closest = entries.reduce((best, entry) => Math.abs(entry.seconds - target) < Math.abs(best.seconds - target) ? entry : best);
		selected.set(closest.seconds, closest);
	}
	const sheets = /* @__PURE__ */ new Map();
	const frames = [];
	for (const entry of [...selected.values()].sort((a, b) => a.seconds - b.seconds)) {
		signal.throwIfAborted();
		const capacity = columns * rows;
		const sheetIndex = Math.floor(entry.index / capacity);
		let sheet = sheets.get(sheetIndex);
		if (!sheet) {
			sheet = await fetchBytes(images[sheetIndex], 4194304);
			const jpeg = sheet[0] === 255 && sheet[1] === 216;
			const png = sheet.subarray(0, 8).equals(Buffer.from([
				137,
				80,
				78,
				71,
				13,
				10,
				26,
				10
			]));
			const webp = sheet.subarray(0, 4).toString() === "RIFF" && sheet.subarray(8, 12).toString() === "WEBP";
			if (!jpeg && !png && !webp) throw new Error("预览图格式不受支持。");
			const info = await sharp(sheet, { limitInputPixels: maxPixels }).metadata();
			signal.throwIfAborted();
			if (info.width !== columns * width || info.height !== rows * height || (info.pages || 1) !== 1) throw new Error("预览拼图与索引尺寸不符。");
			sheets.set(sheetIndex, sheet);
		}
		const tile = entry.index % capacity;
		const fullTile = await sharp(sheet, { limitInputPixels: maxPixels }).extract({
			left: tile % columns * width,
			top: Math.floor(tile / columns) * height,
			width,
			height
		}).png().toBuffer();
		const image = sharp(fullTile, { limitInputPixels: width * height });
		if (crop) image.extract(cropPixels(width, height, crop));
		const bytes = await image.resize({
			width: 640,
			height: 640,
			fit: "inside",
			withoutEnlargement: true
		}).png().toBuffer();
		signal.throwIfAborted();
		if (bytes.length > 2097152) throw new Error("预览帧超限。");
		frames.push({
			seconds: entry.seconds,
			data: bytes,
			source: "storyboard",
			...crop ? {
				region: "crop",
				crop
			} : {}
		});
	}
	return frames;
};

export { extractStoryboardFrames, storyboardUrl };