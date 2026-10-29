// src/panel/pool-observation.ts
const endpointObservation = (endpoint) => {
	const latest = endpoint.lastRequest;
	const call = latest && (latest.status !== void 0 || ["network", "timeout"].includes(latest.reason)) ? latest : endpoint.lastNetworkRequest;
	const hasNetworkEvidence = call && (call.status !== void 0 || ["network", "timeout"].includes(call.reason));
	const fromCall = Boolean(hasNetworkEvidence && call.at >= (endpoint.lastProbeAt || 0));
	return {
		reachability: fromCall ? call.status !== void 0 : endpoint.probeReachable,
		observedAt: fromCall ? call.at : endpoint.lastProbeAt,
		observationSource: fromCall ? call.source === "health-check" ? "health-check" : "call" : endpoint.lastProbeAt ? "probe" : void 0,
		observedStatus: fromCall ? call.status : endpoint.probeStatus
	};
};

export { endpointObservation };