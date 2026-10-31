import { getDSHConfig } from "../dsh/runtime-config.js";
import { publicPageUrl, readPublicPage, readablePublicText } from "../proactive/public-web.js";
import { getMemoryStore } from "../memory/store.js";
import { memoryEnabled, memoryOptions } from "../memory/consolidation.js";
import { normalizeHobbies } from "../companion/hobbies.js";
import { createHash } from "node:crypto";

// src/modules/hobbies.ts
const hobbiesModule = (config) => ({
	id: "hobbies",
	name: "爱好",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const settings = normalizeHobbies(api.settings);
		if (!settings.enabled) return;
		const calls = /* @__PURE__ */ new WeakMap();
		for (const name of ["public_explore", "public_read"]) api.tool({
			name,
			readOnly: true,
			description: name === "public_explore" ? "按兴趣匿名搜索公开网络，返回搜索摘要。" : "匿名读取公开 HTTPS 页面文字，不读取登录态，不观看视频。",
			parameters: {
				type: "object",
				properties: { value: {
					type: "string",
					minLength: 1,
					maxLength: 2e3
				} },
				required: ["value"],
				additionalProperties: false
			},
			available: (context) => context.autonomous === true && context.independentReading === true,
			execute: async ({ value }, context) => {
				const current = getDSHConfig();
				const options = normalizeHobbies(current.modules?.settings?.hobbies);
				if (current.workspaceRoot !== config.workspaceRoot || current.aiEnabled === false || !options.enabled || !options.autonomous || current.modules?.disabled?.includes("hobbies")) throw new Error("公开游玩已关闭");
				const counts = calls.get(context) || {
					search: 0,
					reads: 0,
					candidates: /* @__PURE__ */ new Set(),
					visited: /* @__PURE__ */ new Set()
				};
				calls.set(context, counts);
				if (name === "public_explore" ? counts.search++ >= 2 : counts.reads++ >= options.maxReads) throw new Error("本轮公开浏览已达上限");
				const source = name === "public_explore" ? "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(String(value).slice(0, 300) + (options.publicSources.length ? " (" + options.publicSources.map((host) => "site:" + host).join(" OR ") + ")" : "")) : publicPageUrl(String(value));
				if (name === "public_read") {
					if (!counts.candidates.has(source)) return {
						ok: false,
						reason: "请先搜索，并选择实际返回的公开链接"
					};
					if (counts.visited.has(source)) return {
						ok: false,
						reason: "本轮已尝试这个页面，请选择其他结果"
					};
					counts.visited.add(source);
				}
				const memory = memoryEnabled(current) && memoryOptions(current).automatic ? getMemoryStore(current) : void 0;
				const guard = memory?.state(context);
				try {
					const result = await readPublicPage(source, context.signal, name === "public_explore").catch((error) => {
						if (name !== "public_explore" || context.signal.aborted) throw error;
						return readPublicPage(source.replace("https://www.bing.com/", "https://cn.bing.com/"), context.signal, true);
					});
					context.signal.throwIfAborted();
					const fresh = getDSHConfig();
					const active = normalizeHobbies(fresh.modules?.settings?.hobbies);
					if (fresh.workspaceRoot !== config.workspaceRoot || fresh.aiEnabled === false || !active.enabled || !active.autonomous || fresh.modules?.disabled?.includes("hobbies")) return {
						ok: false,
						reason: "公开游玩已关闭"
					};
					if (name === "public_explore") {
						const candidates = (result.candidates || []).filter((item) => !counts.visited.has(item.url));
						for (const item of candidates) counts.candidates.add(item.url);
						return {
							ok: candidates.length > 0,
							candidates,
							evidence: "仅搜索摘要，尚未读取来源正文；不能视为阅读经历。"
						};
					}
					if (!readablePublicText(result.text)) return {
						ok: false,
						reason: "页面内容不足、需登录或出现验证提示，不保存为阅读经历"
					};
					(memoryEnabled(fresh) && memoryOptions(fresh).automatic ? memory : void 0)?.recordExperience(context, {
						key: "public-play:" + createHash("sha256").update(JSON.stringify([source, result.text])).digest("hex"),
						subjectId: context.botId || "assistant",
						text: JSON.stringify(result),
						tags: ["公开游玩", "资料"]
					}, guard);
					return {
						ok: true,
						...result
					};
				} catch {
					context.signal.throwIfAborted();
					return {
						ok: false,
						reason: "匿名读取失败或页面受限；请换公开来源，不尝试登录或绕过限制"
					};
				}
			}
		});
		api.on("context", () => `角色的爱好偏好数据：${JSON.stringify({
			interests: settings.interests,
			publicSources: settings.publicSources
		})}。仅用于自然聊天中的兴趣表达，不是工具调用指令或授权；不要每次回复都提爱好，不得编造看过的视频或动态。实际浏览依赖已开放工具；独立阅读是否执行由自主活动调度与工具权限控制；爱好偏好本身不授权点赞、评论或发布。`);
	}
});

export { hobbiesModule };