import { getDictionaryStore } from "./dictionary/store.js";
import { getDSHConfig } from "./dsh/runtime-config.js";
import { getQAStore } from "./qa/store.js";
import { personaDetailFields } from "./companion/persona-details.js";
import { getPersonaStore } from "./companion/personas.js";
import { resetGroupSession } from "./dsh/orchestrator.js";
import { readWorkModel, saveWorkModel } from "./panel/work-model.js";
import { recognizeEndpoint } from "./panel/endpoint-recognition.js";
import { poolAction, poolBalances, poolSnapshot, startPoolProbeRun } from "./panel/pool-service.js";
import { readPoolSettings, updatePoolSettings } from "./panel/pool-settings.js";
import KoaRouter from "koa-router";
import bodyParser from "koa-bodyparser";

// src/api-router.ts
const knownSessions = () => {
	const config = getDSHConfig();
	const personas = getPersonaStore(config);
	const scopes = [...getQAStore(config).scopes(), ...personas.scopes()];
	return [...new Map(scopes.map((scope) => [JSON.stringify([scope.platform, scope.channelId]), scope])).values()].map((scope) => ({
		...scope,
		personaId: personas.selected(scope),
		effectivePersonaId: personas.selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona,
		mode: personas.expressionMode(scope)
	}));
};
const sessionTarget = (body) => {
	const scope = knownSessions().find((item) => item.platform === body.platform && item.channelId === body.channelId);
	if (!scope) throw new Error("会话不存在");
	return {
		platform: scope.platform,
		channelId: scope.channelId
	};
};
const apiRouter = new KoaRouter({ prefix: "/api/admin" });
apiRouter.use(async (ctx, next) => {
	ctx.set("Cache-Control", "no-store");
	try {
		await next();
	} catch (error) {
		const conflict = /配置已|正在保存/.test(String(error));
		ctx.status = conflict ? 409 : error.status === 413 ? 413 : 400;
		ctx.body = {
			code: ctx.status,
			message: conflict ? "内容已被更新，请刷新后重试" : "操作未完成，请检查填写内容后重试；若持续失败，请查看服务日志",
			data: null
		};
	}
});
apiRouter.use(bodyParser({
	enableTypes: ["json"],
	jsonLimit: "1mb"
}));
const success = (ctx, data, message = "ok") => {
	ctx.status = 200;
	ctx.body = {
		code: 200,
		message,
		data
	};
};
apiRouter.get("/dictionary", (ctx) => success(ctx, getDictionaryStore(getDSHConfig()).list()));
apiRouter.post("/dictionary", (ctx) => success(ctx, getDictionaryStore(getDSHConfig()).save(ctx.request.body)));
apiRouter.post("/dictionary/delete", (ctx) => {
	const body = ctx.request.body;
	if (typeof body.id !== "string" || !Number.isFinite(body.updatedAt)) ctx.throw(400);
	getDictionaryStore(getDSHConfig()).remove(body.id, body.updatedAt);
	success(ctx, null);
});
apiRouter.get("/sessions", (ctx) => success(ctx, knownSessions()));
apiRouter.post("/persona-selection", async (ctx) => {
	const body = ctx.request.body;
	const scope = sessionTarget(body);
	const config = getDSHConfig();
	const store = getPersonaStore(config);
	if (config.modules?.disabled?.includes("persona")) throw new Error("人设模块未启用");
	if (body.id !== void 0 && typeof body.id !== "string") ctx.throw(400);
	if (body.id) await store.read(body.id);
	await resetGroupSession(scope.channelId, config, () => store.select(scope, body.id || void 0));
	success(ctx, knownSessions(), "人设已应用，已开始新话题");
});
apiRouter.post("/knowledge/edit", (ctx) => {
	const body = ctx.request.body;
	if (typeof body.id !== "string" || !Number.isFinite(body.updatedAt) || !["save", "delete"].includes(body.action)) ctx.throw(400);
	const target = body.scope === "global" ? "global" : sessionTarget(body);
	success(ctx, getQAStore(getDSHConfig()).edit(target, body.id, body.updatedAt, body.action === "delete" ? void 0 : body), body.action === "delete" ? "问答已删除" : "问答已更新");
});
apiRouter.get("/persona-style", (ctx) => success(ctx, { mode: getPersonaStore(getDSHConfig()).expressionMode() }));
apiRouter.post("/persona-style", (ctx) => {
	const body = ctx.request.body;
	getPersonaStore(getDSHConfig()).setExpressionMode(void 0, body.mode, true);
	success(ctx, null, "表达程度已更新");
});
apiRouter.post("/persona-additions", async (ctx) => {
	const body = ctx.request.body;
	const store = getPersonaStore(getDSHConfig());
	await store.read(body.id);
	if (body.clear === true) store.clearAdditions(body.id);
	else {
		if (typeof body.text !== "string") ctx.throw(400);
		store.append(body.id, body.text);
	}
	success(ctx, null, "追加设定已更新");
});
apiRouter.post("/knowledge/search", (ctx) => {
	const body = ctx.request.body;
	if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 1e3 || Boolean(body.platform) !== Boolean(body.channelId)) ctx.throw(400);
	const store = getQAStore(getDSHConfig());
	success(ctx, body.platform && body.channelId ? store.search({
		platform: body.platform,
		channelId: body.channelId
	}, body.query, 10, { record: false }) : store.searchGlobal(body.query));
});
apiRouter.post("/persona-preview", async (ctx) => {
	const body = ctx.request.body;
	const config = getDSHConfig();
	const scope = body.platform || body.channelId ? sessionTarget(body) : {
		platform: "preview",
		channelId: "default"
	};
	const store = getPersonaStore(config);
	success(ctx, {
		id: store.selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona,
		prompt: await store.systemPrompt(config, {
			...scope,
			private: body.private === true,
			owner: body.owner === true
		})
	});
});
apiRouter.get("/persona-detail-fields", (ctx) => success(ctx, personaDetailFields));
apiRouter.get("/personas", async (ctx) => {
	const store = getPersonaStore(getDSHConfig());
	const rows = await store.list();
	success(ctx, await Promise.all(rows.map(async (row) => ({
		...row,
		...row.error ? {} : await store.read(row.id),
		additions: store.additions(row.id)
	}))));
});
apiRouter.post("/personas", async (ctx) => {
	const body = ctx.request.body;
	if (typeof body.revision !== "string") ctx.throw(400);
	await getPersonaStore(getDSHConfig()).save(body);
	success(ctx, null, "人设已保存");
});
apiRouter.get("/knowledge", (ctx) => {
	const store = getQAStore(getDSHConfig());
	const platform = String(ctx.query.platform || "");
	const channelId = String(ctx.query.channelId || "");
	if (platform && channelId) success(ctx, store.list({
		platform,
		channelId
	}, {
		includeGlobal: false,
		limit: 200
	}));
	else if (!platform && !channelId) success(ctx, store.listGlobal(200));
	else ctx.throw(400);
});
apiRouter.post("/knowledge", (ctx) => {
	const body = ctx.request.body;
	if (body.scope !== "global" && (!body.platform || !body.channelId)) ctx.throw(400);
	const target = body.scope === "global" ? "global" : {
		platform: body.platform,
		channelId: body.channelId
	};
	success(ctx, getQAStore(getDSHConfig()).addExplicit(target, body), "问答已保存");
});
apiRouter.get("/pool", async (ctx) => success(ctx, await poolSnapshot()));
apiRouter.post("/pool/probe-all", (ctx) => success(ctx, startPoolProbeRun()));
apiRouter.post("/pool/balances", async (ctx) => {
	const body = ctx.request.body;
	if (body.id !== void 0 && typeof body.id !== "string") ctx.throw(400);
	success(ctx, await poolBalances(body.id));
});
apiRouter.post("/pool/action", async (ctx) => {
	const body = ctx.request.body;
	success(ctx, await poolAction(body?.id, body?.action));
});
apiRouter.post("/pool/recognize", async (ctx) => {
	success(ctx, await recognizeEndpoint(ctx.request.body?.text));
});
apiRouter.get("/pool/settings", async (ctx) => success(ctx, await readPoolSettings()));
apiRouter.post("/pool/settings", async (ctx) => {
	const result = await updatePoolSettings(ctx.request.body);
	success(ctx, result.data, result.message);
});
apiRouter.get("/work-model", async (ctx) => success(ctx, await readWorkModel()));
apiRouter.post("/work-model", async (ctx) => success(ctx, await saveWorkModel(ctx.request.body)));

export { apiRouter as default };