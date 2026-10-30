import { visualCropRequest } from "./crop.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

// src/bili/visual.ts
const run = promisify(execFile);
const visualSampleRequest = (value) => {
	if (value === void 0) return void 0;
	if (!Array.isArray(value) || value.length < 1 || value.length > 3 || value.some((time) => typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 86400)) throw new Error("B 站画面采样位置需要1–3个0–86400秒的有限数值。");
	return [...new Set(value)].sort((a, b) => a - b);
};
const videoSampleTimes = (duration, requestedTimes, count = 3) => {
	if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error("视频时长无效。");
	const requested = visualSampleRequest(requestedTimes);
	if (requested) {
		if (requested.some((time) => time >= duration)) throw new Error("B 站画面采样位置超出当前分P时长。");
		return requested;
	}
	const ratios = count === 9 ? Array.from({ length: 9 }, (_, index) => (index + .5) / 9) : [
		.15,
		.5,
		.85
	];
	return [...new Set(ratios.map((ratio) => Math.min(duration * .999999, Math.round(duration * ratio * 1e3) / 1e3)))];
};
/** Pick within each time segment so a burst of cuts cannot consume the whole image budget. */
const videoSceneSampleTimes = (duration, diagnostic, count = 3) => {
	const fallback = videoSampleTimes(duration, void 0, count);
	const candidates = [...diagnostic.slice(0, 131072).matchAll(/\bpts_time:([0-9]+(?:\.[0-9]+)?)\b/gu)].map((match) => Number(match[1])).filter((time) => Number.isFinite(time) && time > 0 && time < duration);
	return [...new Set(fallback.map((target, index) => {
		const start = index * duration / count;
		const end = (index + 1) * duration / count;
		const selected = candidates.filter((time) => time >= start && time < end).sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
		if (selected === void 0) return target;
		const rounded = Math.round(Math.min(selected + .1, selected + (end - selected) / 2) * 1e3) / 1e3;
		return rounded >= end || rounded < start ? selected : rounded;
	}))].sort((a, b) => a - b);
};
/** Decode only a local MP4, never hand a remote URL or shell expression to ffmpeg. */
const extractVideoFrames = async (data, duration, signal, execute = run, requestedTimes, cropRequest) => {
	signal.throwIfAborted();
	const crop = visualCropRequest(cropRequest);
	if (crop && !visualSampleRequest(requestedTimes)) throw new Error("局部画面读取需要1–3个指定采样位置。");
	if (data.length > 33554432 || data.length < 12 || data.subarray(4, 8).toString() !== "ftyp") throw new Error("视频不是受支持的有限大小 MP4。");
	let times = videoSampleTimes(duration, requestedTimes, 9);
	const root = await mkdtemp(join(tmpdir(), "agent-link-video-"));
	try {
		const input = join(root, "input.mp4");
		await writeFile(input, data, { mode: 384 });
		if (requestedTimes === void 0) try {
			const probe = await execute("ffmpeg", [
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"info",
				"-threads",
				"1",
				"-protocol_whitelist",
				"file,pipe",
				"-f",
				"mov",
				"-i",
				input,
				"-an",
				"-sn",
				"-dn",
				"-filter_threads",
				"1",
				"-vf",
				"fps=2,scale=160:160:force_original_aspect_ratio=decrease,select=gt(scene\\,0.25),showinfo",
				"-f",
				"null",
				"-"
			], {
				signal,
				timeout: 5e3,
				maxBuffer: 131072,
				killSignal: "SIGKILL"
			});
			times = videoSceneSampleTimes(duration, String(probe?.stderr || ""), 9);
		} catch {
			signal.throwIfAborted();
		}
		const frames = [];
		for (const [index, seconds] of times.entries()) {
			signal.throwIfAborted();
			const output = join(root, `${index}.png`);
			await execute("ffmpeg", [
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"error",
				"-threads",
				"1",
				"-protocol_whitelist",
				"file,pipe",
				"-ss",
				String(seconds),
				"-f",
				"mov",
				"-i",
				input,
				"-an",
				"-sn",
				"-dn",
				"-frames:v",
				"1",
				"-vf",
				`${crop ? `crop=iw*${crop.width}:ih*${crop.height}:iw*${crop.x}:ih*${crop.y},` : ""}scale=640:640:force_original_aspect_ratio=decrease`,
				"-threads",
				"1",
				"-y",
				output
			], {
				signal,
				timeout: 1e4,
				maxBuffer: 65536,
				killSignal: "SIGKILL"
			});
			signal.throwIfAborted();
			let bytes;
			try {
				bytes = await readFile(output);
			} catch (error) {
				if (error.code === "ENOENT") continue;
				throw error;
			}
			if (bytes.length > 2097152) throw new Error("视频帧超过限制。");
			const image = await sharp(bytes, { limitInputPixels: 409600 }).png().toBuffer();
			frames.push({
				seconds,
				data: image,
				...crop ? {
					region: "crop",
					crop
				} : {}
			});
		}
		return frames;
	} finally {
		await rm(root, {
			recursive: true,
			force: true
		});
	}
};
/** Keep every full frame and its timestamp, with at most three images per vision request. */
const packVideoFrames = async (frames, signal) => {
	signal.throwIfAborted();
	if (frames.length < 1 || frames.length > 9 || frames.some((frame) => frame.positions || frame.region || !Number.isFinite(frame.seconds) || frame.seconds < 0)) throw new Error("完整画面采样无效。");
	if (frames.some((frame, index) => index > 0 && frame.seconds <= frames[index - 1].seconds)) throw new Error("画面采样顺序无效。");
	if (frames.length <= 3) return frames;
	const boards = [];
	for (let index = 0; index < frames.length; index += 3) {
		const rows = frames.slice(index, index + 3);
		if (rows.some((row) => row.source !== rows[0].source)) throw new Error("画面来源不能混合。");
		const compose = async (size) => {
			let top = 0;
			const layers = [];
			let width = 0;
			for (const row of rows) {
				signal.throwIfAborted();
				if (row.data.length > 2097152) throw new Error("视频帧超过限制。");
				const { data, info } = await sharp(row.data, { limitInputPixels: 409600 }).resize({
					width: size,
					height: size,
					fit: "inside",
					withoutEnlargement: true
				}).removeAlpha().png().toBuffer({ resolveWithObject: true });
				layers.push({
					input: data,
					left: 0,
					top
				});
				width = Math.max(width, info.width);
				top += info.height + 4;
			}
			const composed = await sharp({ create: {
				width,
				height: top - 4,
				channels: 3,
				background: "black"
			} }).composite(layers).png().toBuffer();
			return sharp(composed, { limitInputPixels: 1233920 }).removeAlpha().png().toBuffer();
		};
		let data = await compose(640);
		if (data.length > 2097152) data = await compose(480);
		signal.throwIfAborted();
		if (data.length > 2097152) throw new Error("画面拼图超过限制。");
		boards.push({
			seconds: rows[0].seconds,
			positions: rows.map((row) => row.seconds),
			region: "frame_grid",
			data,
			...rows[0].source ? { source: rows[0].source } : {}
		});
	}
	return boards;
};
const videoDownloadUrl = (value) => {
	const url = new URL(typeof value === "string" ? value : "");
	if (url.protocol !== "https:" || url.username || url.password || url.port || !(url.hostname === "bilivideo.com" || url.hostname.endsWith(".bilivideo.com"))) throw new Error("视频下载来源不受支持。");
	return url;
};

export { extractVideoFrames, packVideoFrames, videoDownloadUrl, videoSampleTimes, videoSceneSampleTimes, visualSampleRequest };