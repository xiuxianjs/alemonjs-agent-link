import { SpeechError } from "./speech-config.js";
import { spawn } from "node:child_process";

// src/media/speech-process.ts
const speechProcess = (command, args, signal, input, env) => {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			shell: false,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				...env
			}
		});
		let out = "", bytes = 0, failed = false;
		let killTimer;
		const stop = () => {
			child.kill("SIGTERM");
			killTimer ??= setTimeout(() => child.kill("SIGKILL"), 500);
			killTimer.unref();
		};
		const collect = (data) => {
			bytes += data.length;
			if (bytes > 65536) {
				failed = true;
				stop();
				return;
			}
			out += data.toString("utf8");
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.stdin.on("error", () => void 0);
		child.on("error", () => {
			failed = true;
		});
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		child.on("close", (code) => {
			clearTimeout(killTimer);
			signal.removeEventListener("abort", stop);
			if (signal.aborted) reject(signal.reason);
			else if (code !== 0 || failed) reject(new SpeechError("engine", "语音进程未完成，请检查引擎安装及音色。"));
			else resolve(out);
		});
		child.stdin.end(input || "", "utf8");
	});
};

export { speechProcess };