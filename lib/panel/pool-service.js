import { fetchPoolBalances } from "../model-pool/balance.js";
import { CredentialPool, getCredentialPool } from "../credentials/pool.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { readReplyGateStatistics } from "../social/reply-gate-statistics.js";
import { endpointObservation } from "./pool-observation.js";
import { readBridgeMetrics } from "../model-pool/bridge-metrics.js";
import { createHash } from "node:crypto";
import { getAppConfig } from "alemonjs";
import { dirname, join } from "node:path";

// src/panel/pool-service.ts
let diagnostics;
const diagnosticPool = () => {
	const active = getCredentialPool(getDSHConfig());
	if (active) {
		diagnostics?.pool.stop();
		diagnostics = void 0;
		return active;
	}
	const app = getAppConfig().value;
	const raw = app.modelPool;
	const config = raw && getDSHConfig({
		...app,
		modelPool: {
			...Array.isArray(raw) ? { keys: raw } : raw,
			enabled: true
		}
	}).modelPool;
	if (!config) {
		diagnostics?.pool.stop();
		diagnostics = void 0;
		return null;
	}
	const fingerprint = JSON.stringify(config);
	if (diagnostics?.fingerprint !== fingerprint) {
		diagnostics?.pool.stop();
		diagnostics = {
			fingerprint,
			pool: new CredentialPool(config, Date.now, join(dirname(getDSHConfig().dshHomeRoot), "model-pool-metrics.json"), true)
		};
	}
	return diagnostics.pool;
};
let balanceSnapshot;
const automaticBalances = (pool) => {
	if (!pool) return void 0;
	const fingerprint = createHash("sha256").update(JSON.stringify(pool.config)).digest("hex");
	if (balanceSnapshot?.fingerprint !== fingerprint) balanceSnapshot = {
		fingerprint,
		checkedAt: 0,
		refreshing: false,
		values: {}
	};
	const snapshot = balanceSnapshot;
	if (!snapshot.refreshing && Date.now() - snapshot.checkedAt >= 6e4) {
		snapshot.refreshing = true;
		fetchPoolBalances(pool.config).then((values) => {
			snapshot.values = Object.fromEntries(values);
		}).catch(() => void 0).finally(() => {
			snapshot.checkedAt = Date.now();
			snapshot.refreshing = false;
		});
	}
	return snapshot;
};
const poolSnapshot = async () => {
	const config = getDSHConfig();
	const pool = getCredentialPool(config);
	const inspected = pool || diagnosticPool();
	const balances = automaticBalances(inspected);
	return {
		replyGateStatistics: readReplyGateStatistics(config),
		probeRun: getPoolProbeRun(),
		sampledAt: Date.now(),
		enabled: Boolean(pool),
		strategy: pool?.config.strategy,
		balanceAlertYuan: pool?.config.balanceAlertYuan,
		balances: balances?.values || {},
		balancesRefreshing: balances?.refreshing || false,
		endpoints: inspected?.status.map((endpoint) => ({
			...endpoint,
			...endpointObservation(endpoint)
		})) ?? [],
		bridge: await readBridgeMetrics(config),
		budget: config.budget ?? { enabled: false }
	};
};
const poolBalances = async (id) => {
	const pool = diagnosticPool();
	if (id && !pool?.status.some((item) => item.id === id)) throw new Error("端点不存在");
	const result = pool ? Object.fromEntries(await fetchPoolBalances(pool.config, true, id)) : {};
	if (balanceSnapshot && pool) {
		balanceSnapshot.values = {
			...balanceSnapshot.values,
			...result
		};
		if (!id) balanceSnapshot.checkedAt = Date.now();
	}
	return result;
};
const poolAction = async (id, action) => {
	if (typeof id !== "string" || ![
		"enable",
		"disable",
		"probe",
		"health-check"
	].includes(String(action))) throw new Error("无效的端点操作");
	const pool = ["probe", "health-check"].includes(String(action)) ? diagnosticPool() : getCredentialPool(getDSHConfig());
	if (!pool?.status.some((item) => item.id === id)) throw new Error("端点不存在");
	if (!(action === "health-check" ? await pool.healthCheckEndpoint(id) : action === "probe" ? await pool.probeEndpoint(id, false) : pool.setEndpointEnabled(id, action === "enable"))) throw new Error("端点操作失败");
	return poolSnapshot();
};
let probeRun;
const getPoolProbeRun = () => probeRun;
const startPoolProbeRun = () => {
	if (probeRun?.running) return probeRun;
	const pool = diagnosticPool();
	if (!pool) throw new Error("未配置额度轮转");
	const run = {
		running: true,
		startedAt: Date.now(),
		finishedAt: void 0,
		results: pool.status.map((item) => ({
			id: item.id,
			state: "pending"
		}))
	};
	probeRun = run;
	(async () => {
		try {
			for (let index = 0; index < run.results.length; index += 2) await Promise.all(run.results.slice(index, index + 2).map(async (item) => {
				item.state = "running";
				try {
					item.state = await pool.probeEndpoint(item.id, false) ? "done" : "failed";
				} catch {
					item.state = "failed";
				}
			}));
		} finally {
			run.running = false;
			run.finishedAt = Date.now();
		}
	})();
	return run;
};

export { getPoolProbeRun, poolAction, poolBalances, poolSnapshot, startPoolProbeRun };