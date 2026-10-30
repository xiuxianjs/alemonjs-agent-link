import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

// src/model-pool/bridge-metrics.ts
const usage = (value) => {
	const item = value && typeof value === "object" ? value : {};
	return {
		requests: Math.max(0, Number(item.requests) || 0),
		input: Math.max(0, Number(item.input) || 0),
		output: Math.max(0, Number(item.output) || 0)
	};
};
const readBridgeMetrics = async (config) => {
	try {
		const raw = JSON.parse(await readFile(join(dirname(config.dshHomeRoot), "model-pool-bridge-metrics.json"), "utf8"));
		const endpoints = {};
		if (raw.endpoints && typeof raw.endpoints === "object") for (const [id, value] of Object.entries(raw.endpoints)) endpoints[id] = usage(value);
		return {
			date: typeof raw.date === "string" ? raw.date : "",
			endpoints,
			personal: usage(raw.personal)
		};
	} catch {
		return null;
	}
};

export { readBridgeMetrics };