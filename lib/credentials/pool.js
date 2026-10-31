import { parseModelPool } from "../model-pool/config.js";
import { tokenUsageFetch } from "../billing/token-usage.js";
import { requestReason } from "../model-pool/request-result.js";
import { fetchPoolBalances } from "../model-pool/balance.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "alemonjs";

// src/credentials/pool.ts
const globalState = globalThis;
const endpointFingerprint = (endpoint) => createHash("sha256").update(JSON.stringify([
	endpoint.id,
	endpoint.provider,
	endpoint.baseUrl,
	endpoint.apiKey,
	endpoint.model,
	endpoint.weight,
	endpoint.maxConcurrent,
	endpoint.capabilities,
	endpoint.enabled
])).digest("hex");
const retryAfterMs = (headers, now) => {
	if (!headers) return 0;
	const value = headers.get("retry-after")?.trim();
	if (value) {
		if (/^\d+(?:\.\d+)?$/u.test(value)) return Math.max(0, Number(value) * 1e3);
		const at = Date.parse(value);
		if (Number.isFinite(at)) return Math.max(0, at - now);
	}
	const reset = headers.get("x-ratelimit-reset-requests")?.trim();
	if (reset) {
		const match = reset.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u);
		if (match) {
			const amount = Number(match[1]);
			const unit = match[2] || "s";
			return Math.max(0, amount * (unit === "ms" ? 1 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 1e3));
		}
	}
	return 0;
};
const rateResetAfter = (headers) => {
	if (!headers) return 0;
	const remaining = headers.get("x-ratelimit-remaining-requests") || headers.get("ratelimit-remaining");
	if (remaining === null || !/^\d+$/u.test(remaining.trim()) || Number(remaining) > 0) return 0;
	const reset = Number(headers.get("x-ratelimit-reset-requests") || headers.get("ratelimit-reset"));
	return Number.isFinite(reset) && reset > 0 ? Math.min(36e5, Math.max(1e3, reset * 1e3)) : 0;
};
var CredentialPool = class {
	config;
	now;
	metricsReadOnly;
	usageFetch(url, init) {
		return this.metricsPath ? tokenUsageFetch({
			dshHomeRoot: join(dirname(this.metricsPath), "dsh-homes"),
			modelPool: this.config
		}, new URL(url), init) : fetch(url, init);
	}
	states;
	retired = /* @__PURE__ */ new Map();
	bindings = /* @__PURE__ */ new Map();
	accounts = /* @__PURE__ */ new Map();
	metricsPath;
	persistTimer;
	persisting = false;
	monitor;
	probing = false;
	constructor(config, now = Date.now, metricsPath, metricsReadOnly = false) {
		this.config = config;
		this.now = now;
		this.metricsReadOnly = metricsReadOnly;
		this.metricsPath = metricsPath;
		this.states = config.endpoints.map((endpoint) => ({
			endpoint,
			active: 0,
			healthRevision: 0,
			failures: 0,
			cooldownUntil: 0,
			disabled: endpoint.enabled === false,
			disabledUntil: endpoint.enabled === false ? Number.POSITIVE_INFINITY : 0,
			lastUsed: 0,
			verified: /* @__PURE__ */ new Set(),
			rejected: /* @__PURE__ */ new Set(),
			capabilityProbed: false,
			recent: [],
			pendingTokens: 0,
			dailyDate: "",
			lifecycle: {
				sent: 0,
				blocked: 0,
				cancelled: 0,
				records: []
			},
			purposeStatistics: {},
			totalCalls: 0,
			successfulCalls: 0,
			failedCalls: 0,
			statisticsSince: this.now(),
			cacheStatistics: {},
			dailyRequests: 0,
			dailyInput: 0,
			dailyOutput: 0,
			requestWindow: [],
			usageWindow: [],
			lastProbeAt: 0,
			lastStatus: void 0,
			latencyMs: 0
		}));
		this.loadMetrics();
	}
	/** Preserve process-local capacity across config generations; leases keep their old credentials. */
	inheritRuntime(previous) {
		if (this.metricsPath !== previous.metricsPath) return;
		for (const [id, state] of previous.retired) this.retired.set(id, state);
		for (const state of previous.states) this.retired.set(state.endpoint.id, state);
		for (const state of this.states) {
			const old = previous.states.find((item) => item.endpoint.id === state.endpoint.id) || previous.retired.get(state.endpoint.id);
			if (!old) continue;
			const keys = [
				"active",
				"pendingTokens",
				"requestWindow",
				"usageWindow"
			];
			if (state.endpoint.apiKey === old.endpoint.apiKey && state.endpoint.baseUrl === old.endpoint.baseUrl && state.endpoint.model === old.endpoint.model) {
				keys.push("cooldownUntil", "failures", "healthy", "healthRevision");
				if (state.endpoint.enabled === old.endpoint.enabled) keys.push("disabled", "disabledUntil");
			}
			for (const key of keys) {
				const descriptor = Object.getOwnPropertyDescriptor(old, key);
				Object.defineProperty(state, key, descriptor?.get ? descriptor : {
					configurable: true,
					enumerable: true,
					get: () => old[key],
					set: (value) => {
						old[key] = value;
					}
				});
			}
		}
		for (const [key, value] of previous.accounts) this.accounts.set(key, value);
	}
	day(now = this.now()) {
		return new Date(now).toISOString().slice(0, 10);
	}
	ensureDaily(state, now = this.now()) {
		const day = this.day(now);
		if (state.dailyDate !== day) {
			state.dailyDate = day;
			state.dailyRequests = 0;
			state.dailyInput = 0;
			state.dailyOutput = 0;
		}
		return state;
	}
	loadMetrics() {
		if (!this.metricsPath) return;
		try {
			const stored = JSON.parse(readFileSync(this.metricsPath, "utf8"));
			const today = this.day();
			for (const state of this.states) {
				const item = stored[state.endpoint.id];
				if (item?.cacheStatistics) state.cacheStatistics = item.cacheStatistics;
				if (item) {
					state.lifecycle = item.lifecycle || state.lifecycle;
					state.purposeStatistics = item.purposeStatistics || {};
					state.totalCalls = Math.max(0, Number(item.totalCalls) || 0);
					state.successfulCalls = Math.max(0, Number(item.successfulCalls) || 0);
					state.failedCalls = Math.max(0, Number(item.failedCalls) || 0);
					state.lastNetworkRequest = item.lastNetworkRequest;
					if (item.lastRequest && typeof item.lastRequest.reason === "string" && Number.isFinite(item.lastRequest.at)) state.lastRequest = {
						at: item.lastRequest.at,
						ok: item.lastRequest.ok,
						source: item.lastRequest.source,
						status: item.lastRequest.status,
						reason: item.lastRequest.reason,
						latencyMs: item.lastRequest.latencyMs
					};
					state.statisticsSince = Number(item.statisticsSince) || this.now();
				}
				if (item?.date !== today) continue;
				state.dailyDate = today;
				state.dailyRequests = Math.max(0, Number(item.requests) || 0);
				state.dailyInput = Math.max(0, Number(item.input) || 0);
				state.dailyOutput = Math.max(0, Number(item.output) || 0);
			}
		} catch {}
	}
	schedulePersist() {
		if (this.metricsReadOnly || !this.metricsPath || this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = void 0;
			this.persistMetrics();
		}, 250);
		this.persistTimer.unref?.();
	}
	persistMetrics() {
		if (this.metricsReadOnly || !this.metricsPath || this.persisting) return;
		this.persisting = true;
		const payload = {};
		try {
			Object.assign(payload, JSON.parse(readFileSync(this.metricsPath, "utf8")));
		} catch {}
		for (const state of this.states) {
			this.ensureDaily(state);
			payload[state.endpoint.id] = {
				date: state.dailyDate,
				lastRequest: state.lastRequest,
				lastNetworkRequest: state.lastNetworkRequest,
				totalCalls: state.totalCalls,
				successfulCalls: state.successfulCalls,
				failedCalls: state.failedCalls,
				statisticsSince: state.statisticsSince,
				cacheStatistics: structuredClone(state.cacheStatistics),
				purposeStatistics: state.purposeStatistics,
				lifecycle: state.lifecycle,
				requests: state.dailyRequests,
				input: state.dailyInput,
				output: state.dailyOutput
			};
		}
		const temp = join(dirname(this.metricsPath), `.${process.pid}.${Date.now()}.metrics.tmp`);
		try {
			mkdirSync(dirname(this.metricsPath), {
				recursive: true,
				mode: 448
			});
			writeFileSync(temp, JSON.stringify(payload), { mode: 384 });
			renameSync(temp, this.metricsPath);
		} catch {
			logger.warn("[agent-link] 调用统计保存失败，重启后可能丢失本次统计");
		} finally {
			this.persisting = false;
		}
	}
	get fingerprint() {
		return JSON.stringify([
			this.config.strategy,
			this.config.maxAttempts,
			this.config.failureThreshold,
			this.config.cooldownSeconds,
			this.config.retryStatuses,
			this.states.map((state) => [state.endpoint.id, endpointFingerprint(state.endpoint)])
		]);
	}
	get status() {
		return this.states.map((state) => ({
			id: state.endpoint.id,
			provider: state.endpoint.provider,
			...state.endpoint.account ? { account: state.endpoint.account } : {},
			model: state.endpoint.model,
			capabilities: this.effectiveCapabilities(state),
			verified: [...state.verified],
			capabilityProbed: state.capabilityProbed,
			fallback: state.endpoint.fallback === true,
			priority: state.endpoint.priority,
			workspace: state.endpoint.workspace === true,
			bound: this.boundCount(state),
			rpm: state.endpoint.rpm,
			tpm: state.endpoint.tpm,
			requests: this.windowStats(state).requests,
			tokens: this.windowStats(state).input + this.windowStats(state).output,
			lastRequest: state.lastRequest,
			lastNetworkRequest: state.lastNetworkRequest,
			totalCalls: state.totalCalls,
			successfulCalls: state.successfulCalls,
			failedCalls: state.failedCalls,
			statisticsSince: state.statisticsSince,
			cacheStatistics: structuredClone(state.cacheStatistics),
			purposeStatistics: state.purposeStatistics,
			lifecycle: state.lifecycle,
			dailyRequests: this.ensureDaily(state).dailyRequests,
			dailyTokens: this.ensureDaily(state).dailyInput + this.ensureDaily(state).dailyOutput,
			recent: this.recentCount(state),
			weight: state.endpoint.weight,
			maxConcurrent: state.endpoint.maxConcurrent,
			active: state.active,
			failures: state.failures,
			cooldownUntil: state.cooldownUntil,
			disabled: state.disabled,
			disabledUntil: state.disabledUntil,
			latencyMs: Math.round(state.latencyMs),
			healthy: state.healthy,
			lastProbeAt: state.lastProbeAt,
			probeReachable: state.probeReachable,
			probeStatus: state.probeStatus,
			lastStatus: state.lastStatus
		}));
	}
	windowStats(target, now = this.now()) {
		const cutoff = now - 6e4;
		while (target.requestWindow.length > 0 && target.requestWindow[0] <= cutoff) target.requestWindow.shift();
		while (target.usageWindow.length > 0 && target.usageWindow[0].at <= cutoff) target.usageWindow.shift();
		return {
			requests: target.requestWindow.length,
			input: target.usageWindow.reduce((sum, item) => sum + item.input, 0),
			output: target.usageWindow.reduce((sum, item) => sum + item.output, 0)
		};
	}
	accountState(name) {
		const current = this.accounts.get(name);
		if (current) return current;
		const fresh = {
			pendingTokens: 0,
			requestWindow: [],
			usageWindow: []
		};
		this.accounts.set(name, fresh);
		return fresh;
	}
	withinLimits(state, now, estimatedTokens) {
		const window = this.windowStats(state, now);
		const accountState = state.endpoint.account ? this.accountState(state.endpoint.account) : void 0;
		const account = accountState ? this.windowStats(accountState, now) : void 0;
		const rpm = state.endpoint.rpm;
		const tpm = state.endpoint.tpm;
		if (rpm !== void 0 && (window.requests >= rpm || account && account.requests >= rpm)) return false;
		if (tpm !== void 0 && (window.input + window.output + state.pendingTokens + estimatedTokens > tpm || account && account.input + account.output + accountState.pendingTokens + estimatedTokens > tpm)) return false;
		return true;
	}
	recordUsage(state, usage, purpose) {
		const bucket = state.cacheStatistics[purpose] ||= {
			reports: 0,
			known: 0,
			input: 0,
			hit: 0
		};
		bucket.reports += 1;
		const input = usage.prompt_tokens;
		const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
		if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(hit) && hit >= 0 && hit <= input) {
			bucket.known += 1;
			bucket.input += input;
			bucket.hit += hit;
		}
		const now = this.now();
		const event = {
			at: now,
			input: Math.max(0, Number(usage.prompt_tokens) || 0),
			output: Math.max(0, Number(usage.completion_tokens) || 0)
		};
		this.windowStats(state, now);
		this.ensureDaily(state, now);
		state.dailyInput += event.input;
		state.dailyOutput += event.output;
		state.usageWindow.push(event);
		this.schedulePersist();
		if (state.endpoint.account) {
			const account = this.accountState(state.endpoint.account);
			this.windowStats(account, now);
			account.usageWindow.push(event);
		}
	}
	recentCount(state, now = this.now()) {
		const window = this.config.balanceWindowSeconds;
		if (window <= 0) return 0;
		const cutoff = now - window * 1e3;
		while (state.recent.length > 0 && state.recent[0] <= cutoff) state.recent.shift();
		return state.recent.length;
	}
	boundCount(state, now = this.now()) {
		let count = 0;
		for (const binding of this.bindings.values()) if (binding.endpointId === state.endpoint.id && binding.expiresAt > now) count += 1;
		return count;
	}
	pruneBindings(now) {
		for (const [key, binding] of this.bindings) if (binding.expiresAt <= now) this.bindings.delete(key);
	}
	effectiveCapabilities(state) {
		const configured = state.capabilityProbed ? state.endpoint.capabilities.filter((capability) => state.verified.has(capability)) : state.endpoint.capabilities;
		const discovered = [...state.verified].filter((capability) => state.endpoint.capabilities.includes("chat") && capability !== "chat" && capability !== "replyGate" && !configured.includes(capability));
		return [.../* @__PURE__ */ new Set([...configured, ...discovered])];
	}
	supports(state, purpose) {
		return this.effectiveCapabilities(state).includes(purpose);
	}
	available(purpose, exclude, provider, estimatedTokens = 0) {
		const time = this.now();
		return this.states.filter((state) => !state.disabled && state.cooldownUntil <= time && state.active < state.endpoint.maxConcurrent && (state.healthy !== false || state.active === 0) && this.supports(state, purpose) && (!provider || state.endpoint.provider === provider) && this.withinLimits(state, time, estimatedTokens) && !exclude.has(state.endpoint.id));
	}
	hasBusyPrimary(purpose, provider, estimatedTokens, workspaceOnly = false) {
		const now = this.now();
		return this.states.some((state) => !state.endpoint.fallback && (!workspaceOnly || state.endpoint.workspace === true) && !state.disabled && state.cooldownUntil <= now && this.supports(state, purpose) && (!provider || state.endpoint.provider === provider) && state.active >= state.endpoint.maxConcurrent && state.healthy !== false && this.withinLimits(state, now, estimatedTokens));
	}
	choose(purpose, _stickyKey, exclude, _stable = false, provider, estimatedTokens = 0, waitForCapacity = false, fallbackOnly = false, workspaceOnly = false) {
		const available = this.available(purpose, exclude, provider, estimatedTokens).filter((state) => !workspaceOnly || state.endpoint.workspace === true);
		if (!available.length) return void 0;
		const primary = fallbackOnly ? [] : available.filter((state) => !state.endpoint.fallback);
		const fallback = available.filter((state) => state.endpoint.fallback);
		if (!fallbackOnly && !primary.length && this.config.queueMaxWaitMs > 0 && waitForCapacity && fallback.length && this.hasBusyPrimary(purpose, provider, estimatedTokens, workspaceOnly)) return void 0;
		const eligible = fallbackOnly ? fallback : primary.length ? primary : fallback;
		if (!eligible.length) return void 0;
		return [...eligible.some((state) => state.healthy !== false) ? eligible.filter((state) => state.healthy !== false) : eligible].sort((a, b) => a.active - b.active || a.endpoint.priority - b.endpoint.priority)[0];
	}
	/** Probe endpoints without spending completion tokens. Called once at
	* startup and then on a timer so requests rarely discover an outage. */
	startHealthMonitor() {
		if (this.monitor || this.config.probeIntervalSeconds <= 0) return;
		this.probeAll(true);
		this.monitor = setInterval(() => void this.probeAll(false), this.config.probeIntervalSeconds * 1e3);
		this.monitor.unref?.();
	}
	stop() {
		if (this.monitor) clearInterval(this.monitor);
		this.monitor = void 0;
		if (this.persistTimer) clearTimeout(this.persistTimer);
		this.persistTimer = void 0;
		this.persistMetrics();
	}
	async probeAll(includeChat = false) {
		if (this.probing) return;
		this.probing = true;
		try {
			const targets = this.states.filter((state) => !state.disabled || this.config.recoveryProbeSeconds > 0 && state.disabledUntil <= this.now());
			const chunkSize = 2;
			for (let index = 0; index < targets.length; index += chunkSize) await Promise.allSettled(targets.slice(index, index + chunkSize).map((state) => this.probe(state, includeChat)));
		} finally {
			this.probing = false;
		}
	}
	async probe(state, includeChat = false) {
		const endpoint = state.endpoint;
		const revision = state.healthRevision;
		const healthy = () => state.healthy !== false;
		const url = `${endpoint.baseUrl.replace(/\/+$/u, "")}/models`;
		state.lastProbeAt = this.now();
		state.probeStatus = void 0;
		const startedAt = this.now();
		try {
			const response = await fetch(url, {
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(this.config.probeTimeoutMs),
				headers: {
					Authorization: `Bearer ${endpoint.apiKey}`,
					Accept: "application/json"
				}
			});
			if (state.healthRevision !== revision) {
				await response.body?.cancel();
				return;
			}
			state.probeReachable = true;
			state.probeStatus = response.status;
			state.lastStatus = response.status;
			if (response.ok) {
				state.healthy = true;
				state.failures = 0;
				const reset = rateResetAfter(response.headers);
				if (state.cooldownUntil <= this.now()) state.cooldownUntil = this.now() + reset;
				else if (reset > 0) state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + reset);
				state.disabled = false;
				state.disabledUntil = 0;
				const sample = Math.max(1, this.now() - startedAt);
				state.latencyMs = state.latencyMs ? state.latencyMs * .7 + sample * .3 : sample;
				await response.body?.cancel();
				if (includeChat && this.config.probeChat && healthy()) {
					await this.probeChat(state);
					if (healthy() && this.config.capabilityProbe) {
						await this.probeVision(state);
						await this.probeTools(state);
					}
				}
				if (includeChat && this.config.capabilityProbe) state.capabilityProbed = true;
				return;
			} else if (response.status === 401 || response.status === 402 || response.status === 403) {
				state.healthy = false;
				state.disabled = true;
				state.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1e3;
			} else if (response.status === 404 || response.status === 405) {
				state.healthy = void 0;
				await response.body?.cancel();
				if (includeChat && this.config.probeChat) {
					await this.probeChat(state);
					if (state.healthy !== false && this.config.capabilityProbe) {
						await this.probeVision(state);
						await this.probeTools(state);
					}
				}
				if (includeChat && this.config.capabilityProbe) state.capabilityProbed = true;
				return;
			} else if (response.status === 429) {
				state.healthy = false;
				state.failures += 1;
				state.cooldownUntil = this.now() + Math.max(this.config.cooldownSeconds * 1e3, retryAfterMs(response.headers, this.now()));
			} else if (response.status >= 500) {
				state.healthy = false;
				state.failures += 1;
				if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
			}
			await response.body?.cancel();
		} catch {
			if (state.healthRevision !== revision) return;
			state.probeReachable = false;
			state.probeStatus = void 0;
			state.healthy = false;
			state.failures += 1;
			if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
		}
	}
	async probeChat(state) {
		const endpoint = state.endpoint;
		const revision = state.healthRevision;
		const url = `${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
		try {
			const response = await this.usageFetch(url, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(this.config.capabilityProbeTimeoutMs),
				headers: {
					Authorization: `Bearer ${endpoint.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json"
				},
				body: JSON.stringify({
					model: endpoint.model,
					messages: [{
						role: "user",
						content: "ping"
					}],
					max_tokens: 16,
					stream: false
				})
			});
			let detail = "";
			if (!response.ok) try {
				const payload = await response.json();
				detail = String(payload.error?.message || payload.message || "").slice(0, 300);
			} catch {}
			if (state.healthRevision !== revision) {
				await response.body?.cancel();
				return;
			}
			state.lastStatus = response.status;
			if (response.ok) {
				state.healthy = true;
				state.failures = 0;
				state.cooldownUntil = 0;
				state.disabled = false;
				state.disabledUntil = 0;
				state.verified.add("chat");
				state.verified.add("replyGate");
			} else if (response.status === 401 || response.status === 402 || response.status === 403) this.disableEndpoint(state);
			else if (response.status === 429) {
				state.healthy = false;
				state.failures += 1;
				state.cooldownUntil = this.now() + Math.max(this.config.cooldownSeconds * 1e3, retryAfterMs(response.headers, this.now()));
			} else if (/计费账户|余额不足|余额已|欠费|冻结|billing|insufficient|quota|frozen|credit/iu.test(detail)) this.disableEndpoint(state);
			else if (response.status >= 500 || response.status === 404 || response.status === 405) {
				state.healthy = false;
				state.failures += 1;
				if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
			}
			if (!response.ok) logger.warn({
				endpoint: endpoint.id,
				model: endpoint.model,
				status: response.status,
				detail,
				action: state.disabled ? "disabled" : "cooldown"
			}, "Startup chat probe rejected endpoint");
			await response.body?.cancel();
		} catch {
			if (state.healthRevision !== revision) return;
			state.healthy = false;
			state.failures += 1;
			if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
		}
	}
	async probeVision(state) {
		const endpoint = state.endpoint;
		const image = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
		try {
			const response = await this.usageFetch(`${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(this.config.capabilityProbeTimeoutMs),
				headers: {
					Authorization: `Bearer ${endpoint.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json"
				},
				body: JSON.stringify({
					model: endpoint.model,
					messages: [{
						role: "user",
						content: [{
							type: "text",
							text: "这张纯色图片是什么颜色？只回答一个词。"
						}, {
							type: "image_url",
							image_url: { url: `data:image/png;base64,${image}` }
						}]
					}],
					max_tokens: 256,
					stream: false
				})
			});
			let detail = "";
			let content = "";
			if (response.ok) {
				const value = (await response.json()).choices?.[0]?.message?.content;
				content = typeof value === "string" ? value : "";
			} else try {
				const payload = await response.json();
				detail = String(payload.error?.message || payload.message || "").slice(0, 300);
			} catch {}
			if (response.ok && content.trim()) state.verified.add("vision");
			else if (response.status === 400 && /image|vision|multimodal|unsupported|图片/iu.test(detail)) state.rejected.add("vision");
			else if (response.status === 429) state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + this.config.cooldownSeconds * 1e3);
			if (!response.ok || !content.trim()) logger.warn({
				endpoint: endpoint.id,
				model: endpoint.model,
				status: response.status,
				vision: content ? "verified" : "unknown",
				detail
			}, "Startup vision capability probe");
		} catch (error) {
			logger.warn({
				endpoint: state.endpoint.id,
				model: state.endpoint.model,
				detail: error instanceof Error ? error.message : String(error)
			}, "Startup vision capability probe inconclusive");
		}
	}
	async probeTools(state) {
		const endpoint = state.endpoint;
		try {
			const response = await this.usageFetch(`${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(this.config.capabilityProbeTimeoutMs),
				headers: {
					Authorization: `Bearer ${endpoint.apiKey}`,
					"Content-Type": "application/json",
					Accept: "application/json"
				},
				body: JSON.stringify({
					model: endpoint.model,
					messages: [{
						role: "user",
						content: "请调用 probe_value 工具获取测试值，不要直接回答。"
					}],
					tools: [{
						type: "function",
						function: {
							name: "probe_value",
							description: "返回一个测试值",
							parameters: {
								type: "object",
								properties: {},
								additionalProperties: false
							}
						}
					}],
					tool_choice: "auto",
					max_tokens: 128,
					stream: false
				})
			});
			let detail = "";
			let calls = 0;
			if (response.ok) calls = (await response.json()).choices?.[0]?.message?.tool_calls?.length || 0;
			else try {
				const payload = await response.json();
				detail = String(payload.error?.message || payload.message || "").slice(0, 300);
			} catch {}
			if (response.ok && calls > 0) state.verified.add("tools");
			else if (response.status === 400 && /tool|function|function_call|工具/iu.test(detail)) state.rejected.add("tools");
			else if (response.status === 429) state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + this.config.cooldownSeconds * 1e3);
			if (!response.ok || calls === 0) logger.warn({
				endpoint: endpoint.id,
				model: endpoint.model,
				status: response.status,
				tools: calls > 0 ? "verified" : "unknown",
				detail
			}, "Startup tool capability probe");
		} catch {}
	}
	/** Manual health check; useful for tests and admin actions. */
	async probeNow(includeChat = false) {
		await this.probeAll(includeChat);
	}
	/**
	* Manual endpoint switch for this process. The configured enabled flag is
	* unchanged, so a restart returns to the configuration file.
	*/
	setEndpointEnabled(id, enabled) {
		const state = this.states.find((item) => item.endpoint.id === id);
		if (!state) return false;
		state.healthRevision += 1;
		if (enabled) {
			state.disabled = false;
			state.disabledUntil = 0;
			state.cooldownUntil = 0;
			state.failures = 0;
			state.healthy = void 0;
		} else {
			state.disabled = true;
			state.disabledUntil = Number.POSITIVE_INFINITY;
			state.healthy = false;
			for (const [key, binding] of this.bindings) if (binding.endpointId === state.endpoint.id) this.bindings.delete(key);
		}
		this.schedulePersist();
		return true;
	}
	healthChecks = /* @__PURE__ */ new Map();
	/** Explicit diagnostic completion, independent of enablement, quota and probe flags. */
	healthCheckEndpoint(id) {
		const current = this.healthChecks.get(id);
		if (current !== void 0) return current;
		const state = this.states.find((item) => item.endpoint.id === id);
		if (!state) return Promise.resolve(false);
		const work = (async () => {
			const started = this.now();
			let status;
			let detail = "";
			let ok = false;
			let errorKind;
			try {
				const response = await this.usageFetch(state.endpoint.baseUrl.replace(/\/+$/u, "") + "/chat/completions", {
					method: "POST",
					redirect: "error",
					headers: {
						Authorization: "Bearer " + state.endpoint.apiKey,
						"Content-Type": "application/json"
					},
					signal: AbortSignal.timeout(Math.min(15e3, this.config.capabilityProbeTimeoutMs)),
					body: JSON.stringify({
						model: state.endpoint.model,
						messages: [{
							role: "user",
							content: "Reply OK."
						}],
						max_tokens: 16,
						stream: false
					})
				});
				status = response.status;
				const payload = await response.json().catch(() => null);
				ok = response.ok && !payload?.error && Array.isArray(payload?.choices) && payload.choices.length > 0 && Boolean(payload.choices[0]?.message);
				detail = String(payload?.error?.code || "") + " " + String(payload?.error?.message || payload?.message || "");
			} catch (error) {
				errorKind = error instanceof Error && /timeout/i.test(error.name) ? "timeout" : void 0;
			}
			state.lastRequest = {
				at: this.now(),
				source: "health-check",
				ok,
				status,
				reason: requestReason({
					ok,
					status,
					detail,
					errorKind
				}),
				latencyMs: Math.max(0, this.now() - started)
			};
			if (status !== void 0 || ["network", "timeout"].includes(state.lastRequest.reason)) state.lastNetworkRequest = state.lastRequest;
			this.schedulePersist();
			return true;
		})();
		this.healthChecks.set(id, work);
		work.finally(() => this.healthChecks.delete(id));
		return work;
	}
	/** Probe one endpoint; includeChat also runs the paid chat probe. */
	async probeEndpoint(id, includeChat = false) {
		const state = this.states.find((item) => item.endpoint.id === id);
		if (!state) return false;
		const wasDisabled = state.disabled;
		const disabledUntil = state.disabledUntil;
		await this.probe(state, includeChat);
		if (wasDisabled) {
			state.disabled = true;
			state.disabledUntil = disabledUntil;
		}
		return true;
	}
	select(options = {}) {
		const purpose = options.purpose || "chat";
		const tried = new Set(options.exclude || []);
		const now = this.now();
		this.pruneBindings(now);
		const state = options.taskEndpoint ? this.states.find((item) => item.endpoint.id === options.taskEndpoint && !(item.disabled && Number.isFinite(item.disabledUntil)) && item.cooldownUntil <= now && this.supports(item, purpose) && this.withinLimits(item, now, options.estimatedTokens || 0)) : this.choose(purpose, void 0, tried, false, options.provider, options.estimatedTokens || 0, options.waitForCapacity === true, options.fallbackOnly === true, options.workspaceOnly === true);
		if (!state) return null;
		tried.add(state.endpoint.id);
		const reserved = options.reserve !== false;
		if (reserved && !options.taskEndpoint) state.active += 1;
		state.lastUsed = now;
		const reservedTokens = reserved ? Math.max(0, options.estimatedTokens || 0) : 0;
		if (reserved) {
			this.windowStats(state, now);
			this.ensureDaily(state, now).dailyRequests += 1;
			state.totalCalls += 1;
			const statistics = state.purposeStatistics[purpose] ||= {
				total: 0,
				success: 0,
				failed: 0
			};
			statistics.total += 1;
			state.requestWindow.push(now);
			this.schedulePersist();
			state.pendingTokens += reservedTokens;
			if (state.endpoint.account) {
				const account = this.accountState(state.endpoint.account);
				this.windowStats(account, now);
				account.requestWindow.push(now);
				account.pendingTokens += reservedTokens;
			}
			if (this.config.balanceWindowSeconds > 0) {
				state.recent.push(now);
				this.recentCount(state, now);
			}
		}
		let held = Boolean(options.taskEndpoint);
		let ended = false;
		let settled = false;
		let sent = false;
		const id = randomUUID();
		const credential = {
			apiKey: state.endpoint.apiKey,
			baseUrl: state.endpoint.baseUrl,
			model: state.endpoint.model,
			...state.endpoint.pricing ? { pricing: state.endpoint.pricing } : {},
			endpointId: state.endpoint.id,
			startedAt: options.startedAt || Date.now(),
			retryBudgetMs: this.config.retryBudgetMs,
			retryJitterMs: this.config.retryJitterMs,
			hold: () => {
				held = true;
			},
			endTask: () => {
				if (ended || options.taskEndpoint) return;
				ended = true;
				if (!settled) credential.report?.({
					ok: false,
					errorKind: "cancelled"
				});
				if (held && reserved) state.active = Math.max(0, state.active - 1);
			},
			renew: (estimatedTokens) => ended ? null : this.select({
				...options,
				taskEndpoint: state.endpoint.id,
				estimatedTokens,
				startedAt: Date.now()
			}),
			reportUsage: (usage) => this.recordUsage(state, usage, purpose),
			invalidate: (status) => this.markInvalid(state, status),
			disable: () => this.disableEndpoint(state),
			maxAttempts: this.config.maxAttempts,
			attempt: 1,
			retryable: (status) => this.config.retryStatuses.includes(status),
			markSent: () => {
				if (sent || settled || !reserved) return;
				sent = true;
				state.lifecycle.sent += 1;
				this.schedulePersist();
			},
			report: (outcome) => {
				if (settled) return;
				settled = true;
				if (reserved) {
					const reason = requestReason(outcome);
					if ([
						"local-budget",
						"pricing-unconfigured",
						"local-disabled"
					].includes(reason)) state.lifecycle.blocked += 1;
					if (reason === "cancelled") state.lifecycle.cancelled += 1;
					state.lifecycle.records.push({
						id,
						requestId: options.requestId || id,
						attempt: credential.attempt || 1,
						purpose,
						at: this.now(),
						sent,
						ok: outcome.ok,
						reason,
						status: outcome.status
					});
					state.lifecycle.records = state.lifecycle.records.slice(-20);
				}
				this.report(state, outcome, reserved, reservedTokens, purpose, !held);
			},
			next: (nextOptions) => {
				if (held && !nextOptions?.initialTask || ended || (credential.attempt || 1) >= this.config.maxAttempts) return null;
				if (Date.now() - (credential.startedAt || Date.now()) >= this.config.retryBudgetMs) return null;
				const next = this.select({
					purpose,
					stickyKey: options.stickyKey,
					reserve: reserved,
					stable: false,
					provider: options.provider,
					fallbackOnly: nextOptions?.fallback === true,
					workspaceOnly: options.workspaceOnly,
					estimatedTokens: options.estimatedTokens,
					startedAt: credential.startedAt,
					requestId: options.requestId || id,
					waitForCapacity: false,
					exclude: tried
				});
				if (next) {
					next.attempt = (credential.attempt || 1) + 1;
					if (nextOptions?.initialTask) {
						credential.endTask?.();
						next.hold?.();
					}
				}
				return next;
			}
		};
		return credential;
	}
	disableEndpoint(state) {
		const account = state.endpoint.account;
		const targets = account ? this.states.filter((item) => item.endpoint.account === account) : [state];
		for (const target of targets) {
			target.healthRevision += 1;
			target.disabled = true;
			target.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1e3;
			target.healthy = false;
			for (const [key, binding] of this.bindings) if (binding.endpointId === target.endpoint.id) this.bindings.delete(key);
		}
	}
	markInvalid(state, status) {
		state.healthRevision += 1;
		state.lastStatus = status;
		state.failures += 1;
		state.healthy = false;
		if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
	}
	report(state, outcome, reserved, reservedTokens = 0, purpose = "chat", releaseActive = true) {
		if (reserved) {
			const statistics = state.purposeStatistics[purpose] ||= {
				total: 0,
				success: 0,
				failed: 0
			};
			if (outcome.ok) statistics.success += 1;
			else statistics.failed += 1;
			state.lastRequest = {
				at: this.now(),
				source: "call",
				ok: outcome.ok,
				status: outcome.status,
				reason: requestReason(outcome),
				latencyMs: outcome.latencyMs
			};
			if (outcome.status !== void 0 || ["network", "timeout"].includes(state.lastRequest.reason)) state.lastNetworkRequest = state.lastRequest;
			if (outcome.ok) state.successfulCalls += 1;
			else state.failedCalls += 1;
			this.schedulePersist();
		}
		if (reserved && releaseActive && state.active > 0) state.active -= 1;
		if (reservedTokens > 0) {
			state.pendingTokens = Math.max(0, state.pendingTokens - reservedTokens);
			if (state.endpoint.account) {
				const account = this.accountState(state.endpoint.account);
				account.pendingTokens = Math.max(0, account.pendingTokens - reservedTokens);
			}
		}
		state.healthRevision += 1;
		state.lastStatus = outcome.status;
		const responseReset = rateResetAfter(outcome.headers);
		if (responseReset > 0) state.cooldownUntil = Math.max(state.cooldownUntil, this.now() + responseReset);
		if (outcome.ok) {
			if (!state.disabled && state.cooldownUntil <= this.now()) {
				state.failures = 0;
				state.healthy = true;
			}
			if (Number.isFinite(outcome.latencyMs) && Number(outcome.latencyMs) > 0) {
				const sample = Number(outcome.latencyMs);
				state.latencyMs = state.latencyMs ? state.latencyMs * .6 + sample * .4 : sample;
			}
			return;
		}
		if ([
			"cancelled",
			"local-budget",
			"local-disabled",
			"pricing-unconfigured"
		].includes(requestReason(outcome))) return;
		const status = outcome.status;
		if (!outcome.ok) {
			for (const [key, binding] of this.bindings) if (binding.endpointId === state.endpoint.id) this.bindings.delete(key);
		}
		if (status === 401 || status === 402 || status === 403) {
			state.disabled = true;
			state.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1e3;
			state.healthy = false;
			return;
		}
		if (status === 429) {
			state.failures += 1;
			state.healthy = false;
			const backoff = this.config.cooldownSeconds * 1e3 * 2 ** Math.min(4, state.failures - 1);
			const retryAfter = retryAfterMs(outcome.headers, this.now());
			state.cooldownUntil = this.now() + Math.min(Math.max(backoff, retryAfter), 36e5);
			return;
		}
		if (status !== void 0 && status >= 500 && status <= 599 || [
			"network",
			"timeout",
			"stream-error"
		].includes(requestReason(outcome))) {
			state.failures += 1;
			state.healthy = false;
			if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
		}
	}
};
const getCredentialPool = (input) => {
	const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : "deepseek-official";
	const baseUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : provider === "deepseek-official" ? "https://api.deepseek.com" : "";
	const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : "deepseek-v4-flash";
	const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : void 0;
	const pool = parseModelPool(input.modelPool, {
		provider,
		baseUrl,
		model,
		apiKey
	});
	if (!pool) {
		globalState.__agentLinkCredentialPool__?.pool.stop();
		if (globalState.__agentLinkCredentialPool__) globalState.__agentLinkDrainingPool__ = globalState.__agentLinkCredentialPool__.pool;
		globalState.__agentLinkCredentialPool__ = void 0;
		return null;
	}
	const metricsPath = typeof input.dshHomeRoot === "string" && input.dshHomeRoot.trim() ? join(dirname(input.dshHomeRoot), "model-pool-metrics.json") : void 0;
	const fingerprint = JSON.stringify([
		metricsPath,
		pool,
		pool.endpoints.map(endpointFingerprint)
	]);
	const existing = globalState.__agentLinkCredentialPool__;
	if (existing?.fingerprint === fingerprint) return existing.pool;
	existing?.pool.stop();
	const instance = new CredentialPool(pool, Date.now, metricsPath);
	const previous = existing?.pool || globalState.__agentLinkDrainingPool__;
	if (previous) instance.inheritRuntime(previous);
	globalState.__agentLinkDrainingPool__ = void 0;
	globalState.__agentLinkCredentialPool__ = {
		fingerprint,
		pool: instance
	};
	return instance;
};
/** Sanitized-enough descriptor for the sandbox bridge; keys stay in the process env. */
const modelPoolForBridge = (input) => {
	const pool = getCredentialPool(input);
	if (!pool) return null;
	const provider = typeof input.provider === "string" && input.provider.trim() ? input.provider.trim() : "deepseek-official";
	const endpoints = pool.config.endpoints.filter((endpoint) => endpoint.enabled && endpoint.provider === provider);
	return endpoints.length ? {
		...pool.config,
		endpoints
	} : null;
};
const warmCredentialPool = (input) => {
	const pool = getCredentialPool(input);
	pool?.startHealthMonitor();
	if (pool) fetchPoolBalances(pool.config).then((balances) => {
		const low = [...balances.values()].filter((item) => item.amount !== void 0 && item.amount < pool.config.balanceAlertYuan);
		if (low.length) logger.warn({
			endpoints: [...balances.entries()].filter(([, item]) => item.amount !== void 0 && item.amount < pool.config.balanceAlertYuan).map(([id]) => id),
			count: low.length,
			threshold: pool.config.balanceAlertYuan
		}, "Model pool low balance at startup");
	}).catch(() => void 0);
	return pool;
};
const stopCredentialPool = () => {
	globalState.__agentLinkCredentialPool__?.pool.stop();
	globalState.__agentLinkCredentialPool__ = void 0;
};

export { CredentialPool, getCredentialPool, modelPoolForBridge, stopCredentialPool, warmCredentialPool };