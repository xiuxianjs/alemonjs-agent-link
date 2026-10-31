import { newsCandidate } from "./group-topics/news.js";
import { getGroupTopicStore, groupTopicId } from "./group-topics/store.js";
import { getDSHConfig } from "./dsh/runtime-config.js";
import { readTokenUsage, rememberTokenKey, tokenKeyId } from "./billing/token-usage.js";
import { imageMime } from "./media/download.js";
import { collectGroupVideoTopics } from "./group-topics/collect.js";
import { readKeyList } from "./panel/key-list.js";
import { AdminInputError } from "./panel/admin-error.js";
import { personaDetailFields } from "./companion/persona-details.js";
import { getPersonaStore } from "./companion/personas.js";
import { readIntelligenceLevel, saveIntelligenceLevel } from "./agent/intelligence.js";
import { getOpinionStore } from "./opinions/store.js";
import { getQAStore } from "./qa/store.js";
import { readScopedPersona, saveScopedPersona } from "./agent/scoped-persona.js";
import { resetGroupSession } from "./dsh/orchestrator.js";
import { getEventStore } from "./events/store.js";
import { getDictionaryStore } from "./dictionary/store.js";
import { readWorkModel, saveWorkModel } from "./panel/work-model.js";
import { readSponsorsSettings, saveSponsorsSettings } from "./panel/sponsors-settings.js";
import { migrateImageSettings, previewImage, readImageSettings, saveImageSettings } from "./panel/image-service.js";
import { saveStickerAsset, stickerAssets, stickerImage, uploadStickerAsset } from "./panel/sticker-service.js";
import { readGeneralSettings, saveGeneralSettings } from "./panel/general-settings.js";
import { readAdsSettings, saveAdsSettings } from "./panel/ads-settings.js";
import { listEndpointModels } from "./panel/model-list.js";
import { readHobbies, saveHobbies } from "./panel/hobbies.js";
import { inspectBiliReadiness } from "./panel/bili-diagnostics.js";
import { migrateVoiceSettings, previewVoice, probeVoices, readVoiceSettings, updateVoiceSettings, voiceBalances, voiceSnapshot } from "./panel/voice-service.js";
import { recognizeEndpoint } from "./panel/endpoint-recognition.js";
import { poolAction, poolBalances, poolSnapshot, startPoolHealthRun, startPoolProbeRun } from "./panel/pool-service.js";
import { readPoolSettings, updatePoolSettings } from "./panel/pool-settings.js";
import { dirname } from "node:path";
import { getAppConfig, logger } from "alemonjs";
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
		logger.warn({
			method: ctx.method,
			path: ctx.path,
			errorType: error instanceof Error ? error.name : "UnknownError",
			errorCode: error?.code,
			stack: error instanceof Error ? error.stack?.split("\n").filter((line) => /^\s+at /.test(line)).slice(0, 8).join("\n") : void 0
		}, "管理接口操作失败");
		ctx.status = conflict ? 409 : error?.status === 413 ? 413 : 400;
		ctx.body = {
			code: ctx.status,
			message: conflict ? "内容已被更新，请刷新后重试" : error instanceof AdminInputError ? error.message : "操作未完成，请检查填写内容后重试；若持续失败，请查看服务日志",
			data: null
		};
	}
});
const standardBody = bodyParser({
	enableTypes: ["json"],
	jsonLimit: "1mb"
});
const stickerUploadBody = bodyParser({
	enableTypes: ["json"],
	jsonLimit: "8mb"
});
apiRouter.use((ctx, next) => (ctx.path === "/api/admin/stickers/upload" ? stickerUploadBody : standardBody)(ctx, next));
const success = (ctx, data, message = "ok") => {
	ctx.status = 200;
	ctx.body = {
		code: 200,
		message,
		data
	};
};
apiRouter.get("/stickers", async (ctx) => success(ctx, await stickerAssets()));
apiRouter.get("/stickers/:id/image", async (ctx) => {
	const image = await stickerImage(ctx.params.id);
	ctx.type = image.mime;
	ctx.set("X-Content-Type-Options", "nosniff");
	ctx.body = image.data;
});
apiRouter.post("/stickers/upload", async (ctx) => success(ctx, await uploadStickerAsset(ctx.request.body)));
apiRouter.post("/stickers/edit", async (ctx) => {
	await saveStickerAsset(ctx.request.body);
	success(ctx, null);
});
apiRouter.post("/stickers/remove", async (ctx) => {
	await saveStickerAsset(ctx.request.body, true);
	success(ctx, null);
});
apiRouter.get("/images/settings", async (ctx) => success(ctx, await readImageSettings()));
apiRouter.post("/images/settings", async (ctx) => {
	const result = await saveImageSettings(ctx.request.body);
	success(ctx, result.data, result.message);
});
apiRouter.post("/images/migrate", async (ctx) => {
	const result = await migrateImageSettings(ctx.request.body);
	success(ctx, result.data, result.message);
});
apiRouter.post("/images/preview", async (ctx) => {
	const data = await previewImage(ctx.request.body);
	ctx.type = imageMime(data);
	ctx.set("X-Content-Type-Options", "nosniff");
	ctx.body = data;
});
apiRouter.get("/dictionary", (ctx) => success(ctx, getDictionaryStore(getDSHConfig()).list()));
apiRouter.post("/dictionary", (ctx) => success(ctx, getDictionaryStore(getDSHConfig()).save(ctx.request.body)));
apiRouter.post("/dictionary/delete", (ctx) => {
	const body = ctx.request.body;
	if (typeof body.id !== "string" || !Number.isFinite(body.updatedAt)) ctx.throw(400);
	getDictionaryStore(getDSHConfig()).remove(body.id, body.updatedAt);
	success(ctx, null);
});
apiRouter.get("/events/evaluations", (ctx) => {
	const offset = Number(ctx.query.offset || 0);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1e6) ctx.throw(400);
	success(ctx, getEventStore(getDSHConfig()).evaluationHistory(offset));
});
apiRouter.post("/events/evaluations/revoke", (ctx) => {
	const body = ctx.request.body;
	if (typeof body.id !== "string" || !Number.isSafeInteger(body.updatedAt)) ctx.throw(400);
	getEventStore(getDSHConfig()).revokeEvaluation(body.id, body.updatedAt);
	success(ctx, null);
});
apiRouter.get("/events", (ctx) => success(ctx, getEventStore(getDSHConfig()).list()));
apiRouter.post("/events", (ctx) => success(ctx, getEventStore(getDSHConfig()).save(ctx.request.body)));
apiRouter.post("/events/delete", (ctx) => {
	const body = ctx.request.body;
	if (typeof body.id !== "string" || !Number.isFinite(body.updatedAt)) ctx.throw(400);
	getEventStore(getDSHConfig()).remove(body.id, body.updatedAt);
	success(ctx, null);
});
apiRouter.get("/opinions", (ctx) => success(ctx, getOpinionStore(getDSHConfig()).list()));
apiRouter.post("/opinions/edit", (ctx) => {
	const body = ctx.request.body;
	if (!body || typeof body.id !== "string" || !Number.isFinite(body.revision)) ctx.throw(400);
	success(ctx, getOpinionStore(getDSHConfig()).edit(body.id, body.revision, body.action, body.value));
});
const intelligenceSessions = () => knownSessions().map((scope) => ({
	...scope,
	level: readIntelligenceLevel(getDSHConfig(), {
		...scope,
		userId: "admin-panel",
		owner: true,
		private: scope.channelId.startsWith("private:")
	}, true)
}));
apiRouter.post("/scoped-persona/read", (ctx) => {
	const scope = sessionTarget(ctx.request.body);
	success(ctx, readScopedPersona(getDSHConfig(), {
		...scope,
		userId: "admin-panel",
		owner: true,
		private: scope.channelId.startsWith("private:")
	}));
});
apiRouter.post("/scoped-persona", async (ctx) => {
	const body = ctx.request.body;
	const scope = sessionTarget(body);
	const identity = {
		...scope,
		userId: "admin-panel",
		owner: true,
		private: scope.channelId.startsWith("private:")
	};
	if (!body.expected || typeof body.expected !== "object" || Array.isArray(body.expected)) ctx.throw(400, "请先读取当前人设");
	await saveScopedPersona(getDSHConfig(), identity, body.details, body.expected);
	success(ctx, readScopedPersona(getDSHConfig(), identity));
});
apiRouter.get("/intelligence", (ctx) => success(ctx, intelligenceSessions()));
apiRouter.post("/intelligence", async (ctx) => {
	const body = ctx.request.body;
	const scope = sessionTarget(body);
	await saveIntelligenceLevel(getDSHConfig(), {
		...scope,
		userId: "admin-panel",
		owner: true,
		private: scope.channelId.startsWith("private:")
	}, body.level);
	success(ctx, intelligenceSessions());
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
apiRouter.get("/faq", (ctx) => success(ctx, getQAStore(getDSHConfig()).questionNotes()));
apiRouter.post("/faq/process", (ctx) => {
	const body = ctx.request.body;
	if (!body || typeof body.id !== "string" || !Number.isSafeInteger(body.updatedAt) || !["dismiss", "publish"].includes(body.action) || body.global !== void 0 && typeof body.global !== "boolean") ctx.throw(400);
	getQAStore(getDSHConfig()).processQuestion(body);
	success(ctx, null);
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
apiRouter.get("/keys", async (ctx) => success(ctx, await readKeyList()));
apiRouter.get("/token-usage", (ctx) => {
	const config = getDSHConfig();
	const root = dirname(config.dshHomeRoot);
	const app = getAppConfig().value;
	if (app.apiKey && (app.baseUrl || config.provider === "deepseek-official")) rememberTokenKey(root, tokenKeyId(new URL(app.baseUrl || "https://api.deepseek.com"), app.apiKey), "工作模型 / 主 Key");
	const labels = /* @__PURE__ */ new Map();
	for (const endpoint of config.modelPool?.endpoints || []) {
		const id = tokenKeyId(new URL(endpoint.baseUrl), endpoint.apiKey);
		labels.set(id, [...labels.get(id) || [], endpoint.id]);
	}
	for (const [id, names] of labels) rememberTokenKey(root, id, names.join("、"));
	success(ctx, readTokenUsage(root, typeof ctx.query.period === "string" ? ctx.query.period : void 0));
});
apiRouter.get("/pool", async (ctx) => success(ctx, await poolSnapshot()));
apiRouter.post("/pool/health-check-all", (ctx) => success(ctx, startPoolHealthRun()));
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
apiRouter.get("/hobbies", async (ctx) => success(ctx, await readHobbies()));
apiRouter.post("/hobbies/diagnostics", async (ctx) => success(ctx, await inspectBiliReadiness()));
apiRouter.post("/hobbies", async (ctx) => success(ctx, await saveHobbies(ctx.request.body)));
apiRouter.get("/work-model", async (ctx) => success(ctx, await readWorkModel()));
apiRouter.post("/work-model", async (ctx) => success(ctx, await saveWorkModel(ctx.request.body)));
apiRouter.post("/voices/migrate", async (ctx) => {
	const result = await migrateVoiceSettings(ctx.request.body);
	success(ctx, result.data, result.message);
});
apiRouter.post("/voices/preview", async (ctx) => {
	const audio = await previewVoice(ctx.request.body);
	ctx.type = audio.extension === "mp3" ? "audio/mpeg" : audio.extension === "wav" ? "audio/wav" : "audio/ogg";
	ctx.set("X-Speech-Engine", audio.engine);
	ctx.set("X-Speech-Fallback", audio.fallbackFrom.join(","));
	ctx.body = audio.data;
});
apiRouter.post("/voices/probe", async (ctx) => success(ctx, await probeVoices(ctx.request.body?.id)));
apiRouter.get("/voices", (ctx) => success(ctx, voiceSnapshot()));
apiRouter.post("/voices/balances", async (ctx) => success(ctx, await voiceBalances(ctx.request.body?.id)));
apiRouter.get("/voices/settings", async (ctx) => success(ctx, await readVoiceSettings()));
apiRouter.post("/voices/settings", async (ctx) => {
	const result = await updateVoiceSettings(ctx.request.body);
	success(ctx, result.data, result.message);
});
apiRouter.post("/models", async (ctx) => success(ctx, await listEndpointModels(ctx.request.body)));
apiRouter.get("/ads", async (ctx) => success(ctx, await readAdsSettings()));
apiRouter.post("/ads", async (ctx) => success(ctx, await saveAdsSettings(ctx.request.body)));
apiRouter.get("/settings", async (ctx) => success(ctx, await readGeneralSettings()));
apiRouter.post("/settings", async (ctx) => {
	const result = await saveGeneralSettings(ctx.request.body);
	success(ctx, result.data, result.message);
});
apiRouter.get("/sponsors", async (ctx) => success(ctx, await readSponsorsSettings()));
apiRouter.post("/sponsors", async (ctx) => success(ctx, await saveSponsorsSettings(ctx.request.body)));
apiRouter.get("/group-topics", (ctx) => {
	const store = getGroupTopicStore(getDSHConfig());
	success(ctx, {
		profiles: store.profiles().map((profile) => ({
			...profile,
			activity: store.activity(profile.id),
			runs: store.runs(profile.id)
		})),
		topics: store.topics()
	});
});
apiRouter.post("/group-topics/profile", (ctx) => {
	const body = ctx.request.body;
	if (!body || ![
		body.platform,
		body.botId,
		body.channelId,
		body.positioning
	].every((value) => typeof value === "string" && value.trim()) || !Array.isArray(body.tags) || !Array.isArray(body.blockedTags)) throw new AdminInputError("请填写完整群身份、定位与标签");
	const profile = {
		...body,
		id: groupTopicId(body.platform, body.botId, body.channelId)
	};
	if ((profile.enabled || profile.shareOut || profile.receiveShared) && !profile.tags.length) throw new AdminInputError("开启权限前请填写标签");
	getGroupTopicStore(getDSHConfig()).saveProfile(profile);
	success(ctx, profile);
});
apiRouter.post("/group-topics/remove", (ctx) => {
	const body = ctx.request.body;
	if (!body || typeof body.id !== "string" || !["profile", "topic"].includes(body.kind || "")) throw new AdminInputError("删除目标无效");
	const store = getGroupTopicStore(getDSHConfig());
	if (body.kind === "profile") store.purgeGroup(body.id);
	else store.removeTopic(body.id);
	success(ctx, null);
});
apiRouter.post("/group-topics/collect", async (ctx) => {
	const body = ctx.request.body;
	if (typeof body?.id !== "string") throw new AdminInputError("请选择群档案");
	success(ctx, { added: await collectGroupVideoTopics(getDSHConfig(), body.id) });
});
apiRouter.get("/group-topics/candidates", (ctx) => {
	if (typeof ctx.query.id !== "string") throw new AdminInputError("请选择群档案");
	success(ctx, getGroupTopicStore(getDSHConfig()).candidates(ctx.query.id));
});
apiRouter.post("/group-topics/news", (ctx) => {
	const body = ctx.request.body;
	if (!body || ![
		body.url,
		body.date,
		body.summary
	].every((value) => typeof value === "string") || !Array.isArray(body.tags)) throw new AdminInputError("新闻字段无效");
	success(ctx, { added: getGroupTopicStore(getDSHConfig()).addTopic(newsCandidate(body.url, body.date, body.tags, body.summary)) });
});

export { apiRouter as default };