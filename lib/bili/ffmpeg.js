import { execFile } from "node:child_process";
import { promisify } from "node:util";

// src/bili/ffmpeg.ts
const execute = promisify(execFile);
/** Local process check only: never receives a URL, cookie, or model credential. */
const checkFfmpeg = async (run = execute) => {
	try {
		const result = await run("ffmpeg", ["-version"], {
			timeout: 3e3,
			maxBuffer: 16384,
			killSignal: "SIGKILL"
		});
		return /^ffmpeg version\s/imu.test(String(result.stdout));
	} catch {
		return false;
	}
};
/** Share concurrent checks, cache for a minute, and allow diagnostics to refresh. */
const createFfmpegAvailability = (check = checkFfmpeg, now = Date.now) => {
	let cached;
	let pending;
	return (fresh = false) => {
		const time = now();
		if (pending !== void 0) return pending;
		if (!fresh && cached && time >= cached.at && time - cached.at < 6e4) return Promise.resolve(cached.available);
		pending = Promise.resolve().then(() => check()).catch(() => false).then((available) => {
			cached = {
				at: now(),
				available
			};
			return available;
		}).finally(() => {
			pending = void 0;
		});
		return pending;
	};
};
const ffmpegAvailable = createFfmpegAvailability();

export { checkFfmpeg, createFfmpegAvailability, ffmpegAvailable };