import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";

// src/bili/audio.ts
const run = promisify(execFile);
const pcmAudioSeconds = (bytes) => {
	if (bytes.length < 44 || bytes.length > 2e6 || bytes.subarray(0, 4).toString() !== "RIFF" || bytes.subarray(8, 12).toString() !== "WAVE") throw new Error("音频片段格式无效。");
	let format = false;
	for (let offset = 12; offset + 8 <= bytes.length;) {
		const kind = bytes.subarray(offset, offset + 4).toString();
		const size = bytes.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (body + size > bytes.length) throw new Error("音频片段不完整。");
		if (kind === "fmt " && size >= 16) format = bytes.readUInt16LE(body) === 1 && bytes.readUInt16LE(body + 2) === 1 && bytes.readUInt32LE(body + 4) === 16e3 && bytes.readUInt32LE(body + 8) === 32e3 && bytes.readUInt16LE(body + 14) === 16;
		if (kind === "data") {
			if (!format || size < 2 || size % 2 || size > 192e4) throw new Error("音频片段没有有效的有界PCM数据。");
			return size / 32e3;
		}
		offset = body + size + size % 2;
	}
	throw new Error("音频片段没有PCM数据。");
};
const extractAudioExcerpt = async (data, start, seconds, signal, execute = run) => {
	signal.throwIfAborted();
	if (data.length < 12 || data.length > 33554432 || data.subarray(4, 8).toString() !== "ftyp" || !Number.isFinite(start) || start < 0 || start > 86400 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new Error("视频音频片段无效。");
	const root = await mkdtemp(join(tmpdir(), "agent-link-video-audio-"));
	try {
		const input = join(root, "input.mp4");
		const output = join(root, "audio.wav");
		await writeFile(input, data, { mode: 384 });
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
			String(start),
			"-f",
			"mov",
			"-i",
			input,
			"-t",
			String(seconds),
			"-vn",
			"-sn",
			"-dn",
			"-map",
			"0:a:0",
			"-ac",
			"1",
			"-ar",
			"16000",
			"-c:a",
			"pcm_s16le",
			"-fs",
			"2000000",
			"-f",
			"wav",
			output
		], {
			signal,
			timeout: 1e4,
			maxBuffer: 16384,
			killSignal: "SIGKILL"
		});
		const bytes = await readFile(output);
		const actualSeconds = pcmAudioSeconds(bytes);
		if (actualSeconds > seconds + .001) throw new Error("音频片段超出请求范围。");
		return {
			data: bytes,
			seconds: Math.min(actualSeconds, seconds)
		};
	} finally {
		await rm(root, {
			recursive: true,
			force: true
		});
	}
};

export { extractAudioExcerpt, pcmAudioSeconds };