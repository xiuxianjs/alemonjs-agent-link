import { videoSampleTimes } from "./visual.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

// src/bili/subtitle-visual.ts
const run = promisify(execFile);
/** Twelve bottom-band samples, grouped into at most three images, never a transcript. */
const extractSubtitleStrips = async (data, duration, signal, execute = run, requestedTimes) => {
	signal.throwIfAborted();
	videoSampleTimes(duration);
	if (data.length > 33554432 || data.length < 12 || data.subarray(4, 8).toString() !== "ftyp") throw new Error("视频不是受支持的有限大小 MP4。");
	const times = requestedTimes === void 0 ? [...new Set(Array.from({ length: 12 }, (_, index) => Math.min(duration * .999999, Math.round((index + .5) * duration / 12 * 1e3) / 1e3)))] : videoSampleTimes(duration, requestedTimes);
	const root = await mkdtemp(join(tmpdir(), "agent-link-subtitle-"));
	try {
		const input = join(root, "input.mp4");
		await writeFile(input, data, { mode: 384 });
		const strips = [];
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
				"crop=iw:ih*0.25:0:ih*0.75,scale=1280:256:force_original_aspect_ratio=decrease",
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
			if (bytes.length > 2097152) throw new Error("字幕采样超过限制。");
			const { data: image, info } = await sharp(bytes, { limitInputPixels: 327680 }).png().toBuffer({ resolveWithObject: true });
			if (info.width > 1280 || info.height > 256) throw new Error("字幕采样尺寸无效。");
			strips.push({
				seconds,
				data: image,
				width: info.width,
				height: info.height
			});
		}
		const boards = [];
		for (let index = 0; index < strips.length; index += 4) {
			signal.throwIfAborted();
			const rows = strips.slice(index, index + 4);
			let top = 0;
			const layers = rows.map((row) => {
				const layer = {
					input: row.data,
					top,
					left: 0
				};
				top += row.height + 2;
				return layer;
			});
			const image = await sharp({ create: {
				width: Math.max(...rows.map((row) => row.width)),
				height: top - 2,
				channels: 3,
				background: "black"
			} }).composite(layers).png().toBuffer();
			signal.throwIfAborted();
			if (image.length > 2097152) throw new Error("字幕拼图超过限制。");
			boards.push({
				seconds: rows[0].seconds,
				positions: rows.map((row) => row.seconds),
				region: "bottom_band",
				data: image
			});
		}
		return boards;
	} catch (error) {
		signal.throwIfAborted();
		throw error;
	} finally {
		await rm(root, {
			recursive: true,
			force: true
		});
	}
};

export { extractSubtitleStrips };