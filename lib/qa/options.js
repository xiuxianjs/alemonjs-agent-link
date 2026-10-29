// src/qa/options.ts
const qaOptions = (config) => {
	const settings = config.modules?.settings?.qa || {};
	const options = {
		autoRecord: settings.autoRecord ?? true,
		recallLimit: settings.recallLimit ?? 3,
		matchThreshold: settings.matchThreshold ?? 3.5,
		maxEntries: settings.maxEntries ?? 200
	};
	if (typeof options.autoRecord !== "boolean" || !Number.isSafeInteger(options.recallLimit) || Number(options.recallLimit) < 1 || Number(options.recallLimit) > 10 || !Number.isFinite(options.matchThreshold) || Number(options.matchThreshold) < 1 || Number(options.matchThreshold) > 20 || !Number.isSafeInteger(options.maxEntries) || Number(options.maxEntries) < 10 || Number(options.maxEntries) > 2e3) throw new Error("qa 模块设置无效。");
	return {
		autoRecord: options.autoRecord,
		recallLimit: Number(options.recallLimit),
		matchThreshold: Number(options.matchThreshold),
		maxEntries: Number(options.maxEntries)
	};
};

export { qaOptions };