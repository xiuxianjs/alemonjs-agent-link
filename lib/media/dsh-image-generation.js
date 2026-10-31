import { MediaError, getMediaConfig } from "./config.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { assertBudgetAvailable } from "../billing/budget.js";
import { imageMime } from "./download.js";
import { acquireProcessLock } from "../runtime/process-lock.js";
import { preparePython } from "../dsh/python-bootstrap.js";
import { PluginPreparation } from "../dsh/plugin-preparation.js";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// src/media/dsh-image-generation.ts
const script = fileURLToPath(new URL("../../python/dsh_imagegen.py", import.meta.url));
const requirements = fileURLToPath(new URL("../../python/requirements.txt", import.meta.url));
const run = (python, args, signal, maxBytes, input = "") => {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(python, [script, ...args], {
			detached: process.platform !== "win32",
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			],
			env: {
				PATH: process.env.PATH,
				LANG: process.env.LANG,
				PYTHONIOENCODING: "utf-8"
			}
		});
		const chunks = [];
		let bytes = 0, oversized = false;
		const stop = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {}
		};
		child.stdout.on("data", (data) => {
			bytes += data.length;
			if (bytes > maxBytes) {
				oversized = true;
				stop();
			} else chunks.push(data);
		});
		child.stdin.on("error", () => void 0);
		child.on("error", () => {
			signal.removeEventListener("abort", stop);
			reject(new MediaError("DSH 生图运行环境不可用。"));
		});
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		child.on("close", (code) => {
			signal.removeEventListener("abort", stop);
			if (signal.aborted) reject(signal.reason);
			else if (code !== 0 || oversized) reject(new MediaError("DSH 生图插件未完成生成，可以降级为简单绘制。"));
			else resolve(Buffer.concat(chunks).toString("utf8"));
		});
		child.stdin.end(input);
	});
};
const prepareDshImageGeneration = async (signal, runtime = getDSHConfig()) => {
	const cache = join(dirname(runtime.dshHomeRoot), "dsh-imagegen");
	try {
		await run(runtime.pythonExecutable, ["check", cache], signal, 4096);
	} catch {
		signal.throwIfAborted();
		await preparePython(runtime, requirements, () => {}, void 0, signal);
	}
	await mkdir(cache, {
		recursive: true,
		mode: 448
	});
	const lock = await acquireProcessLock(join(cache, "install.lock"));
	try {
		lock.assertOwned();
		await run(runtime.pythonExecutable, ["install", cache], signal, 4096);
		lock.assertOwned();
	} finally {
		await lock.release();
	}
	return cache;
};
const preparation = new PluginPreparation();
const dshImagePreparationStatus = () => preparation.status();
const stopDshImagePreparation = () => preparation.stop();
const warmDshImageGeneration = (runtime = getDSHConfig(), media = getMediaConfig()) => {
	if (!media.dshImageFallback || !media.imageGen) {
		preparation.stop();
		return;
	}
	const key = JSON.stringify([runtime.pythonExecutable, runtime.dshHomeRoot]);
	preparation.start(key, (signal) => prepareDshImageGeneration(signal, runtime));
};
/** One isolated SDK tool call; only the selected provider credential enters its process. */
const generateDshImage = async (prompt, config, signal) => {
	if (!config.imageGen || !config.dshImageFallback) throw new MediaError("DSH 生图兜底未启用。");
	if (!prompt.trim() || Array.from(prompt).length > 4e3) throw new MediaError("生图描述需要 1–4000 字符。");
	signal.throwIfAborted();
	await assertBudgetAvailable(getDSHConfig());
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
	const runtime = getDSHConfig();
	const cache = join(dirname(runtime.dshHomeRoot), "dsh-imagegen");
	try {
		await run(runtime.pythonExecutable, ["check-installed", cache], AbortSignal.any([deadline, AbortSignal.timeout(5e3)]), 4096);
	} catch {
		signal.throwIfAborted();
		warmDshImageGeneration(runtime, config);
		throw new MediaError("DSH 生图插件尚未就绪，正在后台准备；本轮可降级为简单绘制。");
	}
	const home = await mkdtemp(join(tmpdir(), "agentlink-dsh-image-"));
	try {
		const output = await run(getDSHConfig().pythonExecutable, [
			"generate",
			cache,
			home
		], deadline, Math.ceil(config.maxBytes * 4 / 3) + 4096, JSON.stringify({
			prompt: [config.imageGen.stylePrompt, prompt].filter(Boolean).join("，"),
			provider: config.imageGen,
			maxBytes: config.maxBytes,
			timeoutMs: config.timeoutMs
		}));
		deadline.throwIfAborted();
		const encoded = JSON.parse(output).data;
		if (typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new MediaError("DSH 生图附件编码无效。");
		const data = Buffer.from(encoded, "base64");
		if (data.length > config.maxBytes || ![
			"image/png",
			"image/jpeg",
			"image/webp"
		].includes(imageMime(data))) throw new MediaError("DSH 生图附件格式或大小无效。");
		return data;
	} finally {
		await rm(home, {
			recursive: true,
			force: true
		});
	}
};

export { dshImagePreparationStatus, generateDshImage, prepareDshImageGeneration, stopDshImagePreparation, warmDshImageGeneration };