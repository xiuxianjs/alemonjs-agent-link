import { readBounded } from "../media/http.js";
import "../media/providers.js";
import { AdminInputError } from "./admin-error.js";
import { hiddenSecret } from "./product-settings-file.js";
import { getAdminStore } from "./admin-panel.js";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

// src/panel/model-list.ts
const listEndpointModels = async (input) => {
	const body = input;
	if (!body || typeof body.baseUrl !== "string" || typeof body.apiKey !== "string") throw new AdminInputError("请先填写请求地址和密钥");
	const url = new URL(body.baseUrl);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new AdminInputError("请求地址必须为无凭证、无查询参数的 HTTPS 地址");
	let apiKey = body.apiKey;
	if (apiKey.startsWith("__AGENTLINK_KEEP_SECRET__")) {
		const store = getAdminStore();
		const masked = JSON.parse((await store.read()).source)["alemonjs-agent-link"];
		const real = parse(await readFile(store.path, "utf8"))["alemonjs-agent-link"];
		const matches = [];
		const visit = (a, b) => {
			if (!a || typeof a !== "object" || !b) return;
			if (a.apiKey === apiKey && typeof b.apiKey === "string") matches.push({
				apiKey: b.apiKey,
				baseUrl: b.baseUrl || (b.provider === "deepseek-official" ? "https://api.deepseek.com" : "")
			});
			for (const key of Object.keys(a)) visit(a[key], b[key]);
		};
		visit(masked, real);
		const match = matches.find((item) => item.baseUrl.replace(/\/+$/u, "") === body.baseUrl.replace(/\/+$/u, ""));
		if (!match) throw new AdminInputError("地址已变更或密钥已更新，请重新填写密钥再获取模型");
		apiKey = match.apiKey;
	}
	if (!apiKey.trim() || /[\r\n]/u.test(apiKey)) throw new AdminInputError("请填写有效密钥");
	try {
		const response = await fetch(body.baseUrl.replace(/\/+$/u, "") + "/models", {
			headers: { Authorization: `Bearer ${apiKey}` },
			redirect: "error",
			signal: AbortSignal.timeout(1e4)
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new AdminInputError(`模型列表查询失败（HTTP ${response.status}）`);
		}
		const payload = JSON.parse((await readBounded(response, 2097152)).toString());
		if (!Array.isArray(payload.data)) throw new AdminInputError("该地址未返回兼容的模型列表");
		return [...new Set(payload.data.map((item) => item?.id).filter((id) => typeof id === "string" && id.length > 0 && id.length <= 300))].sort();
	} catch (error) {
		if (error instanceof AdminInputError) throw error;
		throw new AdminInputError("获取模型列表失败，请检查地址、密钥或供应商是否支持 /models");
	}
};

export { listEndpointModels };