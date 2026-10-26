// src/dsh/errors.ts
var DSHError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = "DSHError";
	}
};
const abortFailure = (error, signal) => {
	const reason = signal?.aborted ? signal.reason : error;
	if (reason instanceof Error && reason.name === "TimeoutError") return new DSHError("timeout", "Agent 请求超过本轮时限");
	if (signal?.aborted || reason instanceof Error && reason.name === "AbortError") return new DSHError("cancelled", "请求已取消");
};

export { DSHError, abortFailure };