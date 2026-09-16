import { getDSHCredentials } from "./credentials.js";
import { logger } from "alemonjs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

//#region src/dsh/supervisor.ts
const bridgeScript = join(dirname(fileURLToPath(import.meta.url)), "../../python/dsh_bridge.py");
const requirementsFile = join(dirname(fileURLToPath(import.meta.url)), "../../python/requirements.txt");
const globalState = globalThis;
const processState = globalState.__agentLinkDSHState__ ??= {
	supervisor: null,
	fingerprint: null,
	bridgeOverride: null
};
let shutdownHookInstalled = false;
const installShutdownHook = () => {
	if (shutdownHookInstalled) return;
	shutdownHookInstalled = true;
	const stopBridge = () => processState.supervisor?.stop();
	process.once("SIGINT", stopBridge);
	process.once("SIGTERM", stopBridge);
	process.once("disconnect", stopBridge);
	process.once("exit", stopBridge);
};
const fingerprintConfig = (config) => JSON.stringify(Object.entries(config).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
const fingerprintCredentials = (credentials) => credentials ? createHash("sha256").update(`${credentials.apiKey}\u0000${credentials.baseUrl ?? ""}\u0000${credentials.model ?? ""}`).digest("hex") : "none";
var DSHSupervisor = class {
	config;
	credentials;
	fingerprint;
	child = null;
	token = randomBytes(32).toString("hex");
	starting = null;
	retries = 0;
	retryTimer = null;
	statusValue = { phase: "idle" };
	stopped = false;
	constructor(config, credentials, fingerprint) {
		this.config = config;
		this.credentials = credentials;
		this.fingerprint = fingerprint;
	}
	async start() {
		const pending = this.starting;
		if (pending !== null) return pending;
		this.stopped = false;
		this.statusValue = { phase: "preparing" };
		this.starting = this.launch();
		try {
			await this.starting;
			this.statusValue = { phase: "ready" };
		} catch (error) {
			this.statusValue = {
				phase: "failed",
				detail: this.describeStartupFailure(error)
			};
			throw error;
		} finally {
			this.starting = null;
		}
	}
	async request() {
		await this.start();
		return {
			url: `http://127.0.0.1:${this.config.bridgePort}`,
			token: this.token
		};
	}
	stop() {
		this.stopped = true;
		this.statusValue = { phase: "stopped" };
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.child?.killed === false) this.child.kill("SIGTERM");
		this.child = null;
	}
	status() {
		return { ...this.statusValue };
	}
	async launch() {
		if (this.child?.exitCode === null) {
			await this.waitForHealth();
			return;
		}
		await this.bootstrapPython();
		if (await this.adoptAuthenticatedBridge()) return;
		await this.assertPortAvailable();
		this.statusValue = { phase: "starting" };
		const env = {
			...process.env,
			DSH_BRIDGE_TOKEN: this.token,
			DSH_WORKSPACE_ROOT: this.config.workspaceRoot,
			DSH_HOME_ROOT: this.config.dshHomeRoot,
			DSH_PROFILE: this.config.profile,
			DSH_PROVIDER: this.config.provider,
			DSH_MODEL: this.credentials?.model || this.config.model,
			DSH_SYSTEM_PROMPT: this.config.defaultSystemPrompt,
			DSH_NODE_VERSION: process.version,
			DSH_MAX_REQUEST_BYTES: String(this.config.maxRequestBytes),
			DSH_WORKER_TIMEOUT_SECONDS: String(Math.max(1, Math.floor((this.config.requestTimeoutMs - 5e3) / 1e3))),
			DSH_MAX_QUEUED_PER_GROUP: String(this.config.maxQueuedPerGroup),
			DSH_MAX_ACTIVE_WORKERS: String(this.config.maxActiveWorkers),
			DSH_MAX_CALLS_PER_USER_PER_MINUTE: String(this.config.maxCallsPerUserPerMinute),
			DSH_RETENTION_DAYS: String(this.config.retentionDays),
			DSH_INPUT_BLOCKED_KEYWORDS: this.config.inputBlockedKeywords.join(","),
			DSH_OUTPUT_BLOCKED_KEYWORDS: this.config.outputBlockedKeywords.join(",")
		};
		delete env.DEEPSEEK_API_KEY;
		delete env.DEEPSEEK_BASE_URL;
		if (this.credentials) {
			env.DEEPSEEK_API_KEY = this.credentials.apiKey;
			const baseUrl = this.credentials.baseUrl || (this.config.provider === "deepseek-official" ? "https://api.deepseek.com" : void 0);
			if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;
		}
		const child = spawn(this.config.pythonExecutable, [
			bridgeScript,
			"--port",
			String(this.config.bridgePort)
		], {
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		this.child = child;
		child.stdout?.on("data", (data) => logger.info({ dsh: String(data).trim() }, "DSH bridge"));
		child.stderr?.on("data", (data) => logger.warn({ dsh: String(data).trim() }, "DSH bridge"));
		child.on("exit", (code, signal) => {
			logger.warn({
				code,
				signal
			}, "DSH bridge exited");
			if (this.child?.pid === child.pid) {
				this.child = null;
				if (!this.stopped) {
					this.statusValue = {
						phase: "failed",
						detail: "DSH Bridge 已退出，正在尝试恢复。"
					};
					this.scheduleRetry();
				}
			}
		});
		await this.waitForHealth();
		await this.writeRuntimeRecord();
	}
	/**
	* A Bridge may outlive its Node parent during a supervisor restart. Reuse it
	* only when a local, owner-only record supplies the matching bearer token
	* and configuration fingerprint. A process merely occupying the port is
	* never trusted or adopted.
	*/
	async adoptAuthenticatedBridge() {
		const record = await this.readRuntimeRecord();
		if (record?.port !== this.config.bridgePort || record?.fingerprint !== this.fingerprint) return false;
		const previousToken = this.token;
		this.token = record.token;
		try {
			await this.waitForHealth(1500);
			logger.info({ port: this.config.bridgePort }, "Reused authenticated DSH bridge");
			return true;
		} catch {
			this.token = previousToken;
			return false;
		}
	}
	runtimeRecordPath() {
		return join(dirname(this.config.dshHomeRoot), "bridge-runtime.json");
	}
	async readRuntimeRecord() {
		const path = this.runtimeRecordPath();
		try {
			const info = await stat(path);
			if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 63) !== 0) return null;
			const value = JSON.parse(await readFile(path, "utf8"));
			if (value.version !== 1 || !Number.isSafeInteger(value.port) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(String(value.token))) return null;
			return value;
		} catch {
			return null;
		}
	}
	async writeRuntimeRecord() {
		const path = this.runtimeRecordPath();
		const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
		const record = {
			version: 1,
			port: this.config.bridgePort,
			token: this.token,
			fingerprint: this.fingerprint
		};
		await mkdir(dirname(path), { recursive: true });
		await writeFile(temporaryPath, JSON.stringify(record), {
			encoding: "utf8",
			mode: 384
		});
		await rename(temporaryPath, path);
	}
	async bootstrapPython() {
		try {
			await access(this.config.pythonExecutable);
			return;
		} catch {}
		const venvRoot = dirname(dirname(this.config.pythonExecutable));
		this.statusValue = { phase: "installing" };
		await mkdir(venvRoot, { recursive: true });
		await this.run("python3", [
			"-m",
			"venv",
			venvRoot
		]);
		await this.run(this.config.pythonExecutable, [
			"-m",
			"pip",
			"install",
			"--requirement",
			requirementsFile
		]);
	}
	run(command, args) {
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, { stdio: "pipe" });
			child.once("error", reject);
			child.once("exit", (code) => code === 0 ? resolve() : reject(/* @__PURE__ */ new Error(`${command} exited with ${code}`)));
		});
	}
	scheduleRetry() {
		if (this.retries >= 5 || this.retryTimer) return;
		const delay = 1e3 * 2 ** this.retries++;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.start().catch((error) => logger.error({ err: error }, "DSH bridge restart failed"));
		}, delay);
		this.retryTimer.unref();
	}
	async assertPortAvailable() {
		if (await new Promise((resolve) => {
			const socket = createConnection({
				host: "127.0.0.1",
				port: this.config.bridgePort
			});
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
			socket.setTimeout(500, () => {
				socket.destroy();
				resolve(false);
			});
		})) throw new Error(`DSH bridge port ${this.config.bridgePort} is already in use`);
	}
	async waitForHealth(timeoutMs = this.config.startupTimeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			let response;
			try {
				response = await fetch(`http://127.0.0.1:${this.config.bridgePort}/health`, { headers: { Authorization: `Bearer ${this.token}` } });
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			if (response.ok) return;
			if (response.status === 503) throw new Error(`DSH bridge preflight failed: ${(await response.text()).slice(0, 240)}`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		this.stop();
		throw new Error("DSH bridge health check timed out");
	}
	describeStartupFailure(error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("preflight failed")) return "安全前置检查失败：请确认 macOS、sandbox-exec、Python 运行时和模型服务配置均有效。";
		if (message.includes("port") && message.includes("already in use")) return `DSH Bridge 端口 ${this.config.bridgePort} 已被占用；请停止旧 Bridge 实例，或在配置中指定其他 bridgePort。`;
		if (message.includes("health check timed out")) return "启动超时。请检查端口是否被占用、Python 环境和网络连接。";
		return "自动准备 DSH 失败。请检查 Python 3、网络连接和插件数据目录权限。";
	}
};
const configureDSHSupervisor = (config, credentials = null) => {
	installShutdownHook();
	const fingerprint = `${fingerprintConfig(config)}:${fingerprintCredentials(credentials)}`;
	if (processState.supervisor && processState.fingerprint === fingerprint) return processState.supervisor;
	processState.supervisor?.stop();
	processState.supervisor = new DSHSupervisor(config, credentials, fingerprint);
	processState.fingerprint = fingerprint;
	return processState.supervisor;
};
const ensureDSHSupervisor = async (config) => {
	if (processState.bridgeOverride) return configureDSHSupervisor(config);
	let credentials = null;
	try {
		credentials = await getDSHCredentials();
	} catch (error) {
		logger.warn({ err: error }, "System credential store unavailable");
	}
	return configureDSHSupervisor(config, credentials);
};
const getDSHBridge = async () => {
	if (processState.bridgeOverride) return processState.bridgeOverride;
	if (!processState.supervisor) throw new Error("DSH supervisor has not been configured");
	return await processState.supervisor.request();
};
const getDSHSupervisorStatus = () => processState.supervisor?.status() ?? { phase: "idle" };
const setDSHBridgeForTesting = (bridge) => {
	processState.bridgeOverride = bridge;
};

//#endregion
export { DSHSupervisor, configureDSHSupervisor, ensureDSHSupervisor, getDSHBridge, getDSHSupervisorStatus, setDSHBridgeForTesting };