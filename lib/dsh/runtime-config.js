import { resolveDSHConfig } from "./config.js";
import { getAppConfig, getConfigValue, onWatchConfigValue } from "alemonjs";
import { isDeepStrictEqual } from "node:util";

// src/dsh/runtime-config.ts
const getDSHConfig = (value, context = {}) => {
	if (value !== void 0) return resolveDSHConfig(value, context);
	const app = getAppConfig();
	return resolveDSHConfig(app.value, {
		configPath: app.path ?? void 0,
		hasRedis: Boolean(getConfigValue().db?.redis),
		...context
	});
};
const watchDSHConfig = (listener) => {
	const app = getAppConfig();
	const snapshot = () => ({
		value: app.value,
		redis: app.value.stateBackend === void 0 && Boolean(getConfigValue().db?.redis)
	});
	let previous = structuredClone(snapshot());
	const notify = () => {
		const current = snapshot();
		if (isDeepStrictEqual(previous, current)) return;
		previous = structuredClone(current);
		listener();
	};
	app.onWatch(notify);
	const stopRedisWatch = onWatchConfigValue(notify);
	return () => {
		app.dispose();
		stopRedisWatch();
	};
};

export { getDSHConfig, watchDSHConfig };