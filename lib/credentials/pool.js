import { parseModelPool } from "../model-pool/config.js";
import { fetchPoolBalances } from "../model-pool/balance.js";
import { createHash } from "node:crypto";
import { logger } from "alemonjs";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

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
	states;
	cursor = 0;
	bindings = /* @__PURE__ */ new Map();
	accounts = /* @__PURE__ */ new Map();
	metricsPath;
	persistTimer;
	persisting = false;
	monitor;
	probing = false;
	constructor(config, now = Date.now, metricsPath) {
		this.config = config;
		this.now = now;
		this.metricsPath = metricsPath;
		this.states = config.endpoints.map((endpoint) => ({
			endpoint,
			active: 0,
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
				if (item?.date !== today) continue;
				state.dailyDate = today;
				state.dailyRequests = Math.max(0, Number(item.requests) || 0);
				state.dailyInput = Math.max(0, Number(item.input) || 0);
				state.dailyOutput = Math.max(0, Number(item.output) || 0);
			}
		} catch {}
	}
	schedulePersist() {
		if (!this.metricsPath || this.persistTimer) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = void 0;
			this.persistMetrics();
		}, 250);
		this.persistTimer.unref?.();
	}
	async persistMetrics() {
		if (!this.metricsPath || this.persisting) return;
		this.persisting = true;
		const payload = {};
		for (const state of this.states) {
			this.ensureDaily(state);
			payload[state.endpoint.id] = {
				date: state.dailyDate,
				requests: state.dailyRequests,
				input: state.dailyInput,
				output: state.dailyOutput
			};
		}
		const temp = join(dirname(this.metricsPath), `.${process.pid}.${Date.now()}.metrics.tmp`);
		try {
			await writeFile(temp, JSON.stringify(payload), { mode: 384 });
			await rename(temp, this.metricsPath);
		} catch {} finally {
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
		const account = state.endpoint.account ? this.windowStats(this.accountState(state.endpoint.account), now) : void 0;
		const rpm = state.endpoint.rpm;
		const tpm = state.endpoint.tpm;
		if (rpm !== void 0 && (window.requests >= rpm || account && account.requests >= rpm)) return false;
		if (tpm !== void 0 && (window.input + window.output + state.pendingTokens + estimatedTokens > tpm || account && account.input + account.output + account.pendingTokens + estimatedTokens > tpm)) return false;
		return true;
	}
	recordUsage(state, usage) {
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
	canUse(state, purpose, exclude, provider) {
		return !state.disabled && state.cooldownUntil <= this.now() && state.active < state.endpoint.maxConcurrent && this.supports(state, purpose) && (!provider || state.endpoint.provider === provider) && !exclude.has(state.endpoint.id);
	}
	effectiveCapabilities(state) {
		const configured = state.capabilityProbed ? state.endpoint.capabilities.filter((capability) => state.verified.has(capability)) : state.endpoint.capabilities;
		const discovered = [...state.verified].filter((capability) => !configured.includes(capability));
		return [.../* @__PURE__ */ new Set([...configured, ...discovered])];
	}
	supports(state, purpose) {
		return this.effectiveCapabilities(state).includes(purpose);
	}
	available(purpose, exclude, provider, estimatedTokens = 0) {
		const time = this.now();
		return this.states.filter((state) => !state.disabled && state.cooldownUntil <= time && state.active < state.endpoint.maxConcurrent && this.supports(state, purpose) && (!provider || state.endpoint.provider === provider) && this.withinLimits(state, time, estimatedTokens) && !exclude.has(state.endpoint.id));
	}
	hasBusyPrimary(purpose, provider, estimatedTokens) {
		const now = this.now();
		return this.states.some((state) => !state.endpoint.fallback && !state.disabled && state.cooldownUntil <= now && this.supports(state, purpose) && (!provider || state.endpoint.provider === provider) && state.active >= state.endpoint.maxConcurrent && state.healthy !== false && this.withinLimits(state, now, estimatedTokens));
	}
	choose(purpose, stickyKey, exclude, stable = false, provider, estimatedTokens = 0, waitForCapacity = false, fallbackOnly = false, workspaceOnly = false) {
		const available = this.available(purpose, exclude, provider, estimatedTokens).filter((state) => !workspaceOnly || state.endpoint.workspace === true);
		if (!available.length) return void 0;
		const primary = fallbackOnly ? [] : available.filter((state) => !state.endpoint.fallback);
		const fallback = available.filter((state) => state.endpoint.fallback);
		if (!fallbackOnly && !primary.length && this.config.queueMaxWaitMs > 0 && waitForCapacity && fallback.length && this.hasBusyPrimary(purpose, provider, estimatedTokens)) return void 0;
		const eligible = fallbackOnly ? fallback : primary.length ? primary : fallback;
		if (!eligible.length) return void 0;
		const tiers = [...new Set(eligible.map((state) => state.endpoint.priority))].sort((left, right) => left - right).map((priority) => eligible.filter((state) => state.endpoint.priority === priority));
		const tier = tiers.find((group) => group.some((state) => state.healthy !== false)) || tiers[0];
		const preferred = tier.filter((state) => state.healthy !== false);
		const candidates = preferred.length ? preferred : tier;
		if (stable) {
			const latency = (state) => state.latencyMs > 0 ? state.latencyMs : 1200;
			return [...candidates].sort((left, right) => latency(left) - latency(right) || right.endpoint.weight - left.endpoint.weight || left.lastUsed - right.lastUsed)[0];
		}
		if (this.config.strategy === "sticky" && stickyKey) return candidates[createHash("sha256").update(stickyKey).digest().readUInt32BE(0) % candidates.length];
		if (this.config.strategy === "least-busy") return [...candidates].sort((left, right) => left.active - right.active || this.recentCount(left) - this.recentCount(right) || left.latencyMs - right.latencyMs || right.endpoint.weight - left.endpoint.weight || left.lastUsed - right.lastUsed)[0];
		if (this.config.strategy === "balanced") return [...candidates].sort((left, right) => {
			const penalty = (state) => Math.min(1e4, state.latencyMs) / 500;
			return (left.active * 2 + this.recentCount(left)) / Math.max(1, left.endpoint.weight) + penalty(left) - ((right.active * 2 + this.recentCount(right)) / Math.max(1, right.endpoint.weight) + penalty(right)) || left.latencyMs - right.latencyMs || right.endpoint.weight - left.endpoint.weight || left.lastUsed - right.lastUsed;
		})[0];
		const expanded = candidates.flatMap((state) => Array.from({ length: state.endpoint.weight }, () => state));
		const selected = expanded[this.cursor % expanded.length];
		this.cursor = (this.cursor + 1) % Math.max(1, expanded.length);
		return selected;
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
		const url = `${endpoint.baseUrl.replace(/\/+$/u, "")}/models`;
		state.lastProbeAt = this.now();
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
				if (includeChat && this.config.probeChat && state.healthy !== false) {
					await this.probeChat(state);
					if (state.healthy !== false && this.config.capabilityProbe) {
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
			state.healthy = false;
			state.failures += 1;
			if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
		}
	}
	async probeChat(state) {
		const endpoint = state.endpoint;
		const url = `${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
		try {
			const response = await fetch(url, {
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
			state.healthy = false;
			state.failures += 1;
			if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
		}
	}
	async probeVision(state) {
		const endpoint = state.endpoint;
		const image = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC";
		try {
			const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
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
			const response = await fetch(`${endpoint.baseUrl.replace(/\/+$/u, "")}/chat/completions`, {
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
		const bindingKey = !options.stable && options.stickyKey ? `${purpose}:${options.stickyKey}` : void 0;
		let state;
		const bound = bindingKey ? this.bindings.get(bindingKey) : void 0;
		if (bound && bound.expiresAt > now && !tried.has(bound.endpointId)) {
			const candidate = this.states.find((item) => item.endpoint.id === bound.endpointId);
			if (!options.fallbackOnly && candidate && candidate.healthy !== false && this.canUse(candidate, purpose, tried, options.provider)) state = candidate;
		}
		if (!state) state = this.choose(purpose, options.stickyKey, tried, options.stable === true, options.provider, options.estimatedTokens || 0, options.waitForCapacity === true, options.fallbackOnly === true);
		if (!state) {
			if (bindingKey) this.bindings.delete(bindingKey);
			return null;
		}
		if (bindingKey && !state.endpoint.fallback && this.config.stickySeconds > 0) this.bindings.set(bindingKey, {
			endpointId: state.endpoint.id,
			expiresAt: now + this.config.stickySeconds * 1e3
		});
		tried.add(state.endpoint.id);
		const reserved = options.reserve !== false;
		if (reserved) state.active += 1;
		state.lastUsed = now;
		const reservedTokens = reserved ? Math.max(0, options.estimatedTokens || 0) : 0;
		if (reserved) {
			this.windowStats(state, now);
			this.ensureDaily(state, now).dailyRequests += 1;
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
		let settled = false;
		const credential = {
			apiKey: state.endpoint.apiKey,
			baseUrl: state.endpoint.baseUrl,
			model: state.endpoint.model,
			...state.endpoint.pricing ? { pricing: state.endpoint.pricing } : {},
			endpointId: state.endpoint.id,
			startedAt: options.startedAt || Date.now(),
			retryBudgetMs: this.config.retryBudgetMs,
			retryJitterMs: this.config.retryJitterMs,
			reportUsage: (usage) => this.recordUsage(state, usage),
			invalidate: (status) => this.markInvalid(state, status),
			disable: () => this.disableEndpoint(state),
			maxAttempts: this.config.maxAttempts,
			attempt: 1,
			retryable: (status) => this.config.retryStatuses.includes(status),
			report: (outcome) => {
				if (settled) return;
				settled = true;
				this.report(state, outcome, reserved, reservedTokens);
			},
			next: (nextOptions) => {
				const next = this.select({
					purpose,
					stickyKey: options.stickyKey,
					reserve: reserved,
					stable: false,
					provider: options.provider,
					fallbackOnly: nextOptions?.fallback === true,
					estimatedTokens: options.estimatedTokens,
					startedAt: credential.startedAt,
					waitForCapacity: false,
					exclude: tried
				});
				if (next) next.attempt = (credential.attempt || 1) + 1;
				return next;
			}
		};
		return credential;
	}
	disableEndpoint(state) {
		const account = state.endpoint.account;
		const targets = account ? this.states.filter((item) => item.endpoint.account === account) : [state];
		for (const target of targets) {
			target.disabled = true;
			target.disabledUntil = this.now() + this.config.recoveryProbeSeconds * 1e3;
			target.healthy = false;
			for (const [key, binding] of this.bindings) if (binding.endpointId === target.endpoint.id) this.bindings.delete(key);
		}
	}
	markInvalid(state, status) {
		state.lastStatus = status;
		state.failures += 1;
		state.healthy = false;
		if (state.failures >= this.config.failureThreshold) state.cooldownUntil = this.now() + this.config.cooldownSeconds * 1e3;
	}
	report(state, outcome, reserved, reservedTokens = 0) {
		if (reserved && state.active > 0) state.active -= 1;
		if (reservedTokens > 0) {
			state.pendingTokens = Math.max(0, state.pendingTokens - reservedTokens);
			if (state.endpoint.account) {
				const account = this.accountState(state.endpoint.account);
				account.pendingTokens = Math.max(0, account.pendingTokens - reservedTokens);
			}
		}
		state.lastStatus = outcome.status;
		if (outcome.ok) {
			state.failures = 0;
			state.cooldownUntil = this.now() + (rateResetAfter(outcome.headers) || 0);
			state.healthy = true;
			state.disabled = false;
			state.disabledUntil = 0;
			if (Number.isFinite(outcome.latencyMs) && Number(outcome.latencyMs) > 0) {
				const sample = Number(outcome.latencyMs);
				state.latencyMs = state.latencyMs ? state.latencyMs * .6 + sample * .4 : sample;
				if (sample > 3e3) {
					for (const [key, binding] of this.bindings) if (binding.endpointId === state.endpoint.id) this.bindings.delete(key);
				}
			}
			return;
		}
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
		if (status !== void 0 && status >= 500 && status <= 599) {
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
		globalState.__agentLinkCredentialPool__ = void 0;
		return null;
	}
	const fingerprint = JSON.stringify([pool, pool.endpoints.map(endpointFingerprint)]);
	const existing = globalState.__agentLinkCredentialPool__;
	if (existing?.fingerprint === fingerprint) return existing.pool;
	existing?.pool.stop();
	const metricsPath = typeof input.dshHomeRoot === "string" && input.dshHomeRoot.trim() ? join(dirname(input.dshHomeRoot), "model-pool-metrics.json") : void 0;
	const instance = new CredentialPool(pool, Date.now, metricsPath);
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