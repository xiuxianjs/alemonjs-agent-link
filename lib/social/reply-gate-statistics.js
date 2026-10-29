import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// src/social/reply-gate-statistics.ts
const records = /* @__PURE__ */ new Map();
const file = (config) => join(dirname(config.workspaceRoot), "reply-gate-statistics.json");
const readReplyGateStatistics = (config) => {
	const path = file(config);
	let value = records.get(path);
	if (!value) {
		value = {
			total: 0,
			success: 0,
			failed: 0,
			since: Date.now(),
			updatedAt: Date.now()
		};
		try {
			const stored = JSON.parse(readFileSync(path, "utf8"));
			if ([
				"total",
				"success",
				"failed",
				"since",
				"updatedAt"
			].every((key) => Number.isSafeInteger(stored[key]) && stored[key] >= 0)) value = stored;
		} catch {}
		records.set(path, value);
	}
	return { ...value };
};
const persist = (config, value) => {
	const path = file(config);
	records.set(path, value);
	try {
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		const temporary = path + "." + process.pid + ".tmp";
		writeFileSync(temporary, JSON.stringify(value), { mode: 384 });
		renameSync(temporary, path);
	} catch {}
};
const beginReplyGateAttempt = (config) => {
	const value = readReplyGateStatistics(config);
	value.total += 1;
	value.updatedAt = Date.now();
	persist(config, value);
	let settled = false;
	return (success) => {
		if (settled) return;
		settled = true;
		const current = readReplyGateStatistics(config);
		if (success) current.success += 1;
		else current.failed += 1;
		current.updatedAt = Date.now();
		persist(config, current);
	};
};

export { beginReplyGateAttempt, readReplyGateStatistics };