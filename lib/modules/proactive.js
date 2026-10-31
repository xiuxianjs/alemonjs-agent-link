import { proactiveOptions } from "../proactive/options.js";
import { GroupTopicWorker } from "../group-topics/worker.js";
import { ProactiveWorker, logProactiveFailure } from "../proactive/worker.js";

// src/modules/proactive.ts
const proactiveModule = (config) => ({
	id: "proactive",
	name: "主动搭话",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		proactiveOptions(config);
		const worker = new ProactiveWorker(config);
		const topics = new GroupTopicWorker(config);
		const timer = setInterval(() => {
			worker.tick().catch(logProactiveFailure);
			topics.tick().catch(logProactiveFailure);
		}, 6e4);
		timer.unref();
		api.onDispose(() => {
			clearInterval(timer);
			worker.stop();
			topics.stop();
		});
	}
});

export { proactiveModule };