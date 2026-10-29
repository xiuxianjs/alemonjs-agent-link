// src/model-pool/request-result.ts
const requestReason = (outcome) => {
	if (outcome.ok) return "success";
	if (outcome.errorKind && [
		"local-budget",
		"cancelled",
		"timeout",
		"invalid-response",
		"stream-error"
	].includes(outcome.errorKind)) return outcome.errorKind;
	const detail = outcome.detail || "";
	if (/frozen|account[_ -]?suspended|账户冻结|账号冻结|已冻结/iu.test(detail)) return "frozen";
	if (/insufficient[_ -]?(balance|quota|credit)|余额不足|额度耗尽|额度用尽|欠费/iu.test(detail) || outcome.status === 402) return "exhausted";
	if (outcome.status === 429) return "rate-limited";
	if (outcome.status === 401) return "invalid";
	if (outcome.status === 403) return "forbidden";
	if (outcome.status === void 0) return "network";
	if (outcome.status >= 500) return "server-error";
	return "request-error";
};

export { requestReason };