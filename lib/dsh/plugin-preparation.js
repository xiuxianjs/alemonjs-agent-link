// src/dsh/plugin-preparation.ts
/** Nonblocking preparation for a verified plugin, with one task per runtime configuration. */
var PluginPreparation = class {
	current;
	status() {
		return this.current?.phase || "idle";
	}
	start(key, prepare, timeoutMs = 24e4) {
		const previous = this.current;
		if (previous?.key === key && (previous.phase !== "failed" || Date.now() < previous.retryAfter)) return;
		previous?.controller.abort();
		const controller = new AbortController();
		const record = {
			key,
			controller,
			phase: "preparing",
			retryAfter: 0,
			done: Promise.resolve()
		};
		this.current = record;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		timer.unref();
		record.done = Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return prepare(controller.signal);
		}).then(() => {
			controller.signal.throwIfAborted();
			if (this.current === record) record.phase = "ready";
		}).catch(() => {
			if (this.current === record) {
				record.phase = "failed";
				record.retryAfter = Date.now() + 6e4;
			}
		}).finally(() => clearTimeout(timer));
	}
	stop() {
		const previous = this.current;
		this.current = void 0;
		previous?.controller.abort();
		return previous ? previous.done : Promise.resolve();
	}
};

export { PluginPreparation };