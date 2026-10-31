// src/dsh/models.ts
const defaultBaseUrl = "https://api.deepseek.com";
const modelListUrl = (baseUrl) => `${(baseUrl || defaultBaseUrl).replace(/\/+$/, "")}/models`;
const listAvailableModels = async (credentials) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 1e4);
	timeout.unref();
	try {
		const response = await fetch(modelListUrl(credentials.baseUrl), {
			headers: { Authorization: `Bearer ${credentials.apiKey}` },
			signal: controller.signal
		});
		if (!response.ok) throw new Error("model list request failed");
		const payload = await response.json();
		if (!payload || !Array.isArray(payload.data)) throw new Error("invalid model list response");
		const models = payload.data.map((item) => item && typeof item.id === "string" ? item.id.trim() : "").filter(Boolean);
		return [...new Set(models)].sort((left, right) => left.localeCompare(right));
	} finally {
		clearTimeout(timeout);
	}
};

export { listAvailableModels };