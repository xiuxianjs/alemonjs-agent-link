import { createHash } from "node:crypto";

// src/proactive/control.ts
const proactiveChannel = (scope) => `private:${JSON.stringify([scope.platform, scope.userId])}`;
const proactiveScopeId = (scope) => createHash("sha256").update(JSON.stringify([
	scope.platform,
	scope.botId,
	scope.userId
])).digest("hex");
const state = globalThis;
const jobs = state.__agentLinkProactiveJobs__ ??= /* @__PURE__ */ new Map();
const key = (root, scope) => JSON.stringify([root, proactiveScopeId(scope)]);
const interruptProactive = (root, scope) => jobs.get(key(root, scope))?.abort();
const interruptAllProactive = () => {
	for (const job of jobs.values()) job.abort();
};
const beginProactive = (root, scope) => {
	const id = key(root, scope);
	if (jobs.has(id) || jobs.size >= 2) return;
	const controller = new AbortController();
	jobs.set(id, controller);
	return {
		signal: controller.signal,
		stop: () => controller.abort(),
		release: () => {
			if (jobs.get(id) === controller) jobs.delete(id);
		}
	};
};

export { beginProactive, interruptAllProactive, interruptProactive, proactiveChannel, proactiveScopeId };