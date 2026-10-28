import { preparePython } from "./python-bootstrap.js";
import { modelPoolForBridge } from "../credentials/pool.js";
import { getDSHCredentials } from "./credentials.js";
import { directChat } from "./direct-chat.js";
import { createHash, randomBytes } from "node:crypto";
import { logger } from "alemonjs";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { fileURLToPath } from "node:url";

// src/dsh/supervisor.ts
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
	attempt = 0;
	preparation = null;
	actualPort;
	nextRetryAt = 0;
	directSessions = /* @__PURE__ */ new Set();
	pendingResets = /* @__PURE__ */ new Set();
	constructor(config, credentials, fingerprint) {
		this.config = config;
		this.credentials = credentials;
		this.fingerprint = fingerprint;
		this.actualPort = config.bridgePort;
	}
	async start() {
		if (this.statusValue.phase === "ready") return;
		if (this.statusValue.phase === "degraded" && (this.config.runtimeMode === "chat-only" || !this.credentials || Date.now() < this.nextRetryAt)) return;
		if (this.starting !== null) return this.starting;
		this.stopped = false;
		const attempt = ++this.attempt;
		const controller = new AbortController();
		this.preparation = controller;
		this.statusValue = { phase: "preparing" };
		const pending = (async () => {
			try {
				await this.writeStartupStatus();
				controller.signal.throwIfAborted();
				await this.launch(controller.signal);
				if (this.attempt !== attempt || this.stopped) return;
				this.retries = 0;
				this.statusValue = { phase: "ready" };
				await this.writeStartupStatus();
			} catch (error) {
				if (this.attempt !== attempt || this.stopped) return;
				this.child?.kill("SIGTERM");
				this.child = null;
				if ((this.config.runtimeMode ?? "auto") !== "sandbox") {
					this.statusValue = {
						phase: "degraded",
						detail: this.config.runtimeMode === "chat-only" && this.credentials ? "普通聊天已就绪。" : `普通聊天模式：${this.describeStartupFailure(error)} 网页暂不可用；受限文件工具按模块及会话权限开放，终端禁止。`
					};
					if (this.credentials && this.config.runtimeMode !== "chat-only") this.scheduleRetry();
					await this.writeStartupStatus();
					return;
				}
				this.statusValue = {
					phase: "failed",
					detail: this.describeStartupFailure(error)
				};
				await this.writeStartupStatus();
				throw error;
			} finally {
				if (this.attempt === attempt) {
					this.starting = null;
					this.preparation = null;
				}
			}
		})();
		this.starting = pending;
		return await pending;
	}
	async prepareForChat() {
		if (this.config.runtimeMode === "sandbox" || this.config.runtimeMode === "chat-only") {
			await this.start();
			return;
		}
		this.start().catch(() => void 0);
	}
	useSandbox(sessionId) {
		if (this.directSessions.has(sessionId)) return false;
		if (this.statusValue.phase === "ready") return true;
		this.directSessions.add(sessionId);
		return false;
	}
	queueSessionReset(sessionId) {
		if ((this.config.runtimeMode ?? "auto") === "auto") this.pendingResets.add(sessionId);
	}
	async flushSessionResets(signal) {
		while (this.pendingResets.size) {
			signal.throwIfAborted();
			const id = this.pendingResets.values().next().value;
			const response = await fetch(`http://127.0.0.1:${this.actualPort}/v1/session/${encodeURIComponent(id)}`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${this.token}` },
				signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.startupTimeoutMs)])
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("Deferred session reset failed");
			}
			await response.body?.cancel();
			this.pendingResets.delete(id);
		}
	}
	resetTransport(sessionId) {
		for (const id of this.directSessions) if (id === sessionId || id.startsWith(`${sessionId}:v`)) this.directSessions.delete(id);
	}
	async request() {
		await this.start();
		return {
			url: `http://127.0.0.1:${this.actualPort}`,
			token: this.token
		};
	}
	stop() {
		this.stopped = true;
		this.attempt++;
		this.preparation?.abort();
		this.preparation = null;
		this.starting = null;
		this.statusValue = { phase: "stopped" };
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.child?.killed === false) this.child.kill("SIGTERM");
		this.child = null;
	}
	status() {
		return {
			...this.statusValue,
			chatReady: Boolean(this.credentials) && !this.stopped && (this.statusValue.phase === "ready" || (this.config.runtimeMode ?? "auto") !== "sandbox")
		};
	}
	async chatDirect(message, signal, onEvent, privateHistory, onCompleted) {
		await directChat(this.config, this.credentials, message, signal, onEvent, privateHistory, onCompleted);
	}
	async launch(signal) {
		if (!this.credentials) throw new Error("Model credentials missing");
		if (this.config.runtimeMode === "chat-only") throw new Error("chat-only selected");
		if (!["darwin", "linux"].includes(process.platform)) throw new Error("Native Windows sandbox unavailable");
		if (process.platform === "darwin") await access("/usr/bin/sandbox-exec");
		if (process.platform === "linux") {
			const candidates = process.env.DSH_BWRAP_EXECUTABLE ? [process.env.DSH_BWRAP_EXECUTABLE] : (process.env.PATH || "").split(":").filter(Boolean).map((path) => join(path, "bwrap"));
			if (!(await Promise.all(candidates.map((path) => access(path).then(() => true, () => false)))).some(Boolean)) throw new Error("bubblewrap unavailable");
		}
		if (this.child?.exitCode === null) {
			await this.waitForHealth(this.config.startupTimeoutMs, signal);
			return;
		}
		await this.bootstrapPython(signal);
		signal.throwIfAborted();
		if (await this.adoptAuthenticatedBridge()) {
			await this.flushSessionResets(signal);
			return;
		}
		signal.throwIfAborted();
		if (this.config.bridgePort === 0) this.actualPort = await this.choosePort();
		await this.assertPortAvailable();
		signal.throwIfAborted();
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
		delete env.DSH_MODEL_POOL;
		const pool = modelPoolForBridge(this.config);
		if (pool) env.DSH_MODEL_POOL = JSON.stringify(pool);
		if (this.credentials) {
			env.DEEPSEEK_API_KEY = this.credentials.apiKey;
			const baseUrl = this.credentials.baseUrl || (this.config.provider === "deepseek-official" ? "https://api.deepseek.com" : void 0);
			if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl;
		}
		const child = spawn(this.config.pythonExecutable, [
			bridgeScript,
			"--port",
			String(this.actualPort)
		], {
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		this.child = child;
		child.on("error", () => {
			this.child = null;
		});
		child.stdout?.resume();
		child.stderr?.resume();
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
		await this.waitForHealth(this.config.startupTimeoutMs, signal);
		await this.flushSessionResets(signal);
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
		if (!record || this.config.bridgePort !== 0 && record.port !== this.config.bridgePort || record.fingerprint !== this.fingerprint) return false;
		const previousToken = this.token;
		const previousPort = this.actualPort;
		this.actualPort = record.port;
		this.token = record.token;
		try {
			await this.waitForHealth(1500);
			return true;
		} catch {
			this.token = previousToken;
			this.actualPort = previousPort;
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
			port: this.actualPort,
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
	async bootstrapPython(signal) {
		await preparePython(this.config, requirementsFile, () => {
			this.statusValue = { phase: "installing" };
			this.writeStartupStatus();
		}, void 0, signal);
	}
	scheduleRetry() {
		if (this.retryTimer || this.stopped) return;
		const delay = Math.min(3e5, 3e4 * 2 ** Math.min(this.retries++, 4));
		this.nextRetryAt = Date.now() + delay;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.nextRetryAt = 0;
			this.start().catch(() => void 0);
		}, delay);
		this.retryTimer.unref();
	}
	choosePort() {
		return new Promise((resolve, reject) => {
			const server = createServer();
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				const port = typeof address === "object" && address ? address.port : 0;
				server.close((error) => error ? reject(error) : resolve(port));
			});
		});
	}
	async assertPortAvailable() {
		if (await new Promise((resolve) => {
			const socket = createConnection({
				host: "127.0.0.1",
				port: this.actualPort
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
		})) throw new Error(`DSH bridge port ${this.actualPort} is already in use`);
	}
	async waitForHealth(timeoutMs = this.config.startupTimeoutMs, signal) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			let response;
			try {
				response = await fetch(`http://127.0.0.1:${this.actualPort}/health`, {
					headers: { Authorization: `Bearer ${this.token}` },
					signal: AbortSignal.any([...signal ? [signal] : [], AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now())))])
				});
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 250));
				continue;
			}
			if (response.ok) return;
			if (response.status === 503) throw new Error(`DSH bridge preflight failed: ${(await response.text()).slice(0, 240)}`);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error("DSH bridge health check timed out");
	}
	writeStartupStatus() {
		const attempt = this.attempt;
		const record = {
			...this.status(),
			platform: process.platform,
			arch: process.arch,
			node: process.version,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		};
		const write = async () => {
			try {
				if (attempt !== this.attempt) return;
				const path = join(dirname(this.config.dshHomeRoot), "startup-status.json");
				await mkdir(dirname(path), { recursive: true });
				const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
				await writeFile(temp, JSON.stringify(record), { mode: 384 });
				if (attempt !== this.attempt) {
					await unlink(temp).catch(() => void 0);
					return;
				}
				await rename(temp, path);
			} catch {}
		};
		const pending = (processState.statusWrite ?? Promise.resolve()).then(write);
		processState.statusWrite = pending;
		return pending;
	}
	describeStartupFailure(error) {
		const message = error instanceof Error ? error.message : "";
		if (message.includes("Model credentials missing")) return "请填写 alemon.config.yaml 中的 alemonjs-agent-link.apiKey 后重新启动。";
		if (message.includes("Windows sandbox")) return "当前系统不提供受支持的本地沙箱。";
		if (message.includes("bubblewrap")) return "未找到 Linux Bubblewrap 沙箱。";
		if (message.includes("No usable Python")) return "未找到可用的 Python/venv。";
		if (message.includes("sources unavailable")) return "依赖下载源不可用；联网后重启可重试。";
		if (message.includes("Configured Python")) return "自定义 Python 环境不可用，请检查 pythonExecutable。";
		if (message.includes("preflight failed")) return "安全前置检查失败：请确认系统沙箱、Python 运行时和模型服务配置均有效。";
		if (message.includes("port") && message.includes("already in use")) return `DSH Bridge 端口 ${this.actualPort} 已被占用；请停止旧 Bridge 实例，或在配置中指定其他 bridgePort。`;
		if (message.includes("health check timed out")) return "启动超时。请检查端口是否被占用、Python 环境和网络连接。";
		return "自动准备 DSH 失败。请检查 Python 3、网络连接和插件数据目录权限。";
	}
};
const configureDSHSupervisor = (config, credentials = null) => {
	installShutdownHook();
	const fingerprint = createHash("sha256").update(`${fingerprintConfig(config)}:${fingerprintCredentials(credentials)}`).digest("hex");
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
const hasDSHBridgeOverride = () => processState.bridgeOverride !== null;
const setDSHBridgeForTesting = (bridge) => {
	processState.bridgeOverride = bridge;
};

export { DSHSupervisor, configureDSHSupervisor, ensureDSHSupervisor, getDSHBridge, getDSHSupervisorStatus, hasDSHBridgeOverride, setDSHBridgeForTesting };