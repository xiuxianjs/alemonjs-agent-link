import { parseModelPool } from "../model-pool/config.js";
import { createHash } from "node:crypto";

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
var CredentialPool = class {
	config;
	now;
	states;
	cursor = 0;
	constructor(config, now = Date.now) {
		this.config = config;
		this.now = now;
		this.states = config.endpoints.map((endpoint) => ({
			endpoint,
			active: 0,
			failures: 0,
			cooldownUntil: 0,
			disabled: endpoint.enabled === false,
			lastUsed: 0
		}));
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
			active: state.active,
			failures: state.failures,
			cooldownUntil: state.cooldownUntil,
			disabled: state.disabled
		}));
	}
	available(purpose, exclude) {
		const time = this.now();
		return this.states.filter((state) => !state.disabled && state.cooldownUntil <= time && state.active < state.endpoint.maxConcurrent && state.endpoint.capabilities.includes(purpose) && !exclude.has(state.endpoint.id));
	}
	choose(purpose, stickyKey, exclude, stable = false) {
		const available = this.available(purpose, exclude);
		if (!available.length) return void 0;
		if (stable) return available[0];
		if (this.config.strategy === "sticky" && stickyKey) return available[createHash("sha256").update(stickyKey).digest().readUInt32BE(0) % available.length];
		if (this.config.strategy === "least-busy") return [...available].sort((left, right) => left.active - right.active || right.endpoint.weight - left.endpoint.weight || left.lastUsed - right.lastUsed)[0];
		const expanded = available.flatMap((state) => Array.from({ length: state.endpoint.weight }, () => state));
		const selected = expanded[this.cursor % expanded.length];
		this.cursor = (this.cursor + 1) % Math.max(1, expanded.length);
		return selected;
	}
	select(options = {}) {
		const purpose = options.purpose || "chat";
		const tried = new Set(options.exclude || []);
		const state = this.choose(purpose, options.stickyKey, tried, options.stable === true);
		if (!state) return null;
		tried.add(state.endpoint.id);
		const reserved = options.reserve !== false;
		if (reserved) state.active += 1;
		state.lastUsed = this.now();
		let settled = false;
		const credential = {
			apiKey: state.endpoint.apiKey,
			baseUrl: state.endpoint.baseUrl,
			model: state.endpoint.model,
			endpointId: state.endpoint.id,
			maxAttempts: this.config.maxAttempts,
			attempt: 1,
			retryable: (status) => this.config.retryStatuses.includes(status),
			report: (outcome) => {
				if (settled) return;
				settled = true;
				this.report(state, outcome, reserved);
			},
			next: () => {
				const next = this.select({
					purpose,
					stickyKey: options.stickyKey,
					reserve: reserved,
					stable: false,
					exclude: tried
				});
				if (next) next.attempt = (credential.attempt || 1) + 1;
				return next;
			}
		};
		return credential;
	}
	report(state, outcome, reserved) {
		if (reserved && state.active > 0) state.active -= 1;
		if (outcome.ok) {
			state.failures = 0;
			state.cooldownUntil = 0;
			return;
		}
		const status = outcome.status;
		if (status === 401 || status === 402 || status === 403) {
			state.disabled = true;
			return;
		}
		if (status === 429) {
			state.failures += 1;
			const backoff = this.config.cooldownSeconds * 1e3 * 2 ** Math.min(4, state.failures - 1);
			state.cooldownUntil = this.now() + Math.min(backoff, 36e5);
			return;
		}
		if (status !== void 0 && status >= 500 && status <= 599) {
			state.failures += 1;
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
		globalState.__agentLinkCredentialPool__ = void 0;
		return null;
	}
	const fingerprint = JSON.stringify([pool, pool.endpoints.map(endpointFingerprint)]);
	const existing = globalState.__agentLinkCredentialPool__;
	if (existing?.fingerprint === fingerprint) return existing.pool;
	const instance = new CredentialPool(pool);
	globalState.__agentLinkCredentialPool__ = {
		fingerprint,
		pool: instance
	};
	return instance;
};
/** Sanitized-enough descriptor for the sandbox bridge; keys stay in the process env. */
const modelPoolForBridge = (input) => {
	const pool = getCredentialPool(input);
	return pool ? pool.config : null;
};

export { CredentialPool, getCredentialPool, modelPoolForBridge };