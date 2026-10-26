import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

// src/dsh/python-bootstrap.ts
const runQuiet = (command, args, timeout) => new Promise((resolveRun, reject) => {
	const child = spawn(command, args, {
		stdio: "ignore",
		windowsHide: true,
		env: {
			...process.env,
			PIP_NO_INPUT: "1",
			PIP_DISABLE_PIP_VERSION_CHECK: "1"
		}
	});
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		reject(/* @__PURE__ */ new Error("Python preparation timed out"));
	}, timeout);
	child.once("error", (error) => {
		clearTimeout(timer);
		reject(error);
	});
	child.once("close", (code) => {
		clearTimeout(timer);
		if (code === 0) resolveRun();
		else reject(/* @__PURE__ */ new Error("Python preparation failed"));
	});
});
const probe = ["-c", "from deepseek_harness import DeepSeekHarness; from deepseek_harness_runtime import bundled_runtime_path; bundled_runtime_path()"];
const preparePython = async (config, requirements, installing, run = runQuiet) => {
	try {
		await run(config.pythonExecutable, probe, Math.min(config.startupTimeoutMs, 5e3));
		return;
	} catch {}
	const managedRoot = join(dirname(config.dshHomeRoot), "venv");
	const managedPython = join(managedRoot, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
	if (resolve(config.pythonExecutable) !== resolve(managedPython)) throw new Error("Configured Python environment is unavailable; automatic installation only manages the plugin venv");
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
	} catch {}
	if (!created) throw new Error("No usable Python with venv");
	const sources = [...config.pythonPackageSources];
	const lastSource = join(dirname(managedRoot), "python-source.json");
	try {
		const saved = JSON.parse(await readFile(lastSource, "utf8"));
		if (sources.includes(saved.source)) {
			sources.splice(sources.indexOf(saved.source), 1);
			sources.unshift(saved.source);
		}
	} catch {}
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
			continue;
		}
		const temp = `${lastSource}.${process.pid}.tmp`;
		await writeFile(temp, JSON.stringify({ source }), { mode: 384 });
		await rename(temp, lastSource);
		return;
	}
	throw new Error("Python package sources unavailable; retry startup when connected");
};

export { preparePython, runQuiet };