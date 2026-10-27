import { appendDiagnostic } from "../bin/diagnostics.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

// src/dsh/python-bootstrap.ts
const runQuiet = (command, args, timeout, signal, diagnosticPath) => new Promise((resolveRun, reject) => {
	signal?.throwIfAborted();
	const child = spawn(command, args, {
		stdio: [
			"ignore",
			"ignore",
			"pipe"
		],
		windowsHide: true,
		env: {
			...process.env,
			PIP_NO_INPUT: "1",
			PIP_DISABLE_PIP_VERSION_CHECK: "1"
		}
	});
	let errors = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (data) => {
		errors = errors.length + String(data).length > 8e3 ? "[Python 失败信息过长，已省略]" : errors + data;
	});
	const abort = () => {
		child.kill("SIGKILL");
	};
	signal?.addEventListener("abort", abort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
		if (diagnosticPath) appendDiagnostic(diagnosticPath, "Python 准备超时。\n" + errors);
	}, timeout);
	child.once("error", (error) => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		reject(error);
	});
	child.once("close", (code) => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		if (timedOut) {
			reject(/* @__PURE__ */ new Error("Python preparation timed out"));
			return;
		}
		if (code === 0) resolveRun();
		else {
			if (diagnosticPath) appendDiagnostic(diagnosticPath, "Python 准备失败。\n" + errors);
			reject(/* @__PURE__ */ new Error("Python preparation failed"));
		}
	});
});
const probe = ["-c", "from deepseek_harness import DeepSeekHarness; from deepseek_harness_runtime import bundled_runtime_path; assert callable(getattr(DeepSeekHarness, \"resume_session\", None)), \"DSH SDK requires native session resume support\"; bundled_runtime_path()"];
const preparePython = async (config, requirements, installing, runner = runQuiet, signal) => {
	const deadline = Date.now() + (config.preparationTimeoutMs ?? 12e4);
	const run = async (command, args, timeout) => {
		signal?.throwIfAborted();
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Python preparation timed out");
		await runner(command, args, Math.min(remaining, timeout), signal, join(dirname(config.dshHomeRoot), "startup.log"));
		signal?.throwIfAborted();
	};
	try {
		await run(config.pythonExecutable, probe, Math.min(config.startupTimeoutMs, 5e3));
		return;
	} catch {
		signal?.throwIfAborted();
	}
	const managedRoot = join(dirname(config.dshHomeRoot), "venv");
	const managedPython = join(managedRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	if (resolve(config.pythonExecutable) !== resolve(managedPython)) throw new Error("Configured Python environment is unavailable; automatic installation only manages the plugin venv");
	signal?.throwIfAborted();
	installing();
	await mkdir(dirname(managedRoot), { recursive: true });
	let created = false;
	for (const command of ["python3", "python"]) try {
		await run(command, [
			"-m",
			"venv",
			managedRoot
		], config.startupTimeoutMs);
		created = true;
		break;
	} catch {
		signal?.throwIfAborted();
		if (Date.now() >= deadline) throw new Error("Python preparation timed out");
	}
	if (!created) throw new Error("No usable Python with venv");
	const sources = [...new Set(config.pythonPackageSources)];
	let failures = {};
	const lastSource = join(dirname(managedRoot), "python-source.json");
	try {
		const saved = JSON.parse(await readFile(lastSource, "utf8"));
		failures = saved.failures && typeof saved.failures === "object" ? saved.failures : {};
		if (sources.includes(saved.source)) {
			sources.splice(sources.indexOf(saved.source), 1);
			sources.unshift(saved.source);
		}
	} catch {}
	sources.sort((left, right) => Number(Date.now() - (failures[left] ?? 0) < 3e5) - Number(Date.now() - (failures[right] ?? 0) < 3e5));
	const saveSource = async (source) => {
		const temp = `${lastSource}.${process.pid}.tmp`;
		await writeFile(temp, JSON.stringify({
			source,
			failures: Object.fromEntries(sources.filter((url) => failures[url]).map((url) => [url, failures[url]]))
		}), { mode: 384 });
		await rename(temp, lastSource);
	};
	for (const source of sources) {
		try {
			await run(config.pythonExecutable, [
				"-m",
				"pip",
				"--isolated",
				"install",
				"--no-input",
				"--disable-pip-version-check",
				"--only-binary=:all:",
				"--timeout",
				"10",
				"--retries",
				"1",
				"--index-url",
				source,
				"--requirement",
				requirements
			], config.startupTimeoutMs);
			await run(config.pythonExecutable, probe, Math.min(config.startupTimeoutMs, 5e3));
		} catch {
			signal?.throwIfAborted();
			if (Date.now() >= deadline) throw new Error("Python preparation timed out");
			failures[source] = Date.now();
			await saveSource();
			continue;
		}
		Reflect.deleteProperty(failures, source);
		await saveSource(source);
		return;
	}
	throw new Error("Python package sources unavailable; retry startup when connected");
};

export { preparePython, runQuiet };