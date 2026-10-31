import { MediaError } from "./config.js";
import { readBounded } from "./http.js";
import { DSHError } from "../dsh/errors.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { getCredentialPool } from "../credentials/pool.js";
import { BudgetExceededError, budgetedFetch } from "../billing/budget.js";

// src/media/vision.ts
/** Configuration preflight only. Do not reserve capacity until images are ready. */
const visionSource = (media, config) => {
	if (media.vision) return "explicit";
	const pool = (config || getDSHConfig()).modelPool;
	return pool?.enabled && pool.endpoints.some((endpoint) => endpoint.enabled && endpoint.capabilities.includes("vision")) ? "model_pool" : void 0;
};
/** Shared robot vision routing; explicit providers remain the caller's first choice. */
const withVisionProvider = async (media, signal, operation, estimatedTokens = 8192) => {
	if (media.vision) return operation(media);
	signal.throwIfAborted();
	const config = getDSHConfig();
	if (visionSource(media, config) !== "model_pool") throw new MediaError("未配置视觉服务。");
	const excluded = new Set(config.modelPool.endpoints.filter((endpoint) => !endpoint.capabilities.includes("vision")).map((endpoint) => endpoint.id));
	const credentials = getCredentialPool(config)?.select({
		purpose: "vision",
		reserve: true,
		estimatedTokens,
		exclude: excluded
	});
	if (!credentials) throw new MediaError("视觉模型池当前没有可用容量。");
	const provider = {
		apiKey: credentials.apiKey,
		baseUrl: credentials.baseUrl,
		model: credentials.model
	};
	const started = Date.now();
	let status;
	let headers;
	let dispatched = false;
	try {
		if (!provider.baseUrl || !provider.model) throw new MediaError("视觉端点配置不完整。");
		const result = await operation({
			...media,
			vision: {
				...provider,
				baseUrl: provider.baseUrl,
				model: provider.model
			}
		}, async (target, path, body, requestSignal, maxBytes) => {
			const response = await budgetedFetch(config, new URL(`${target.baseUrl}/${path}`), {
				method: "POST",
				redirect: "error",
				signal: requestSignal,
				headers: {
					Authorization: `Bearer ${target.apiKey}`,
					"Content-Type": "application/json"
				},
				body,
				robotKey: true,
				pricing: credentials.pricing,
				onDispatch: () => {
					dispatched = true;
					credentials.markSent?.();
				}
			});
			status = response.status;
			headers = response.headers;
			const bytes = await readBounded(response, maxBytes);
			const payload = JSON.parse(bytes.toString("utf8"));
			credentials.reportUsage?.(payload?.usage || {});
			return bytes;
		});
		credentials.report?.({
			ok: true,
			status,
			headers,
			latencyMs: Date.now() - started
		});
		return result;
	} catch (error) {
		credentials.report?.({
			ok: false,
			status,
			headers,
			latencyMs: Date.now() - started,
			errorKind: signal.aborted ? "cancelled" : error instanceof BudgetExceededError || error instanceof DSHError && ["budget", "disabled"].includes(error.kind) ? "local-budget" : dispatched && status === void 0 ? "network" : "invalid-response"
		});
		signal.throwIfAborted();
		throw error;
	}
};

export { visionSource, withVisionProvider };