import { getDSHConfig } from "../dsh/runtime-config.js";
import { webModule } from "../modules/web.js";
import { containsPrivateOutput } from "../dsh/private-output.js";
import { mediaCapabilitiesModule } from "../modules/media-capabilities.js";
import { interactionModule } from "../modules/interaction.js";
import { validateArguments } from "./schema.js";
import { hobbiesModule } from "../modules/hobbies.js";
import { opinionsModule } from "../modules/opinions.js";
import { conversationModule } from "../modules/conversation.js";
import { eventsModule } from "../modules/events.js";
import { affinityModule } from "../modules/affinity.js";
import { dictionaryModule } from "../modules/dictionary.js";
import { filesModule } from "../modules/files.js";
import { exposeModule } from "../modules/expose.js";
import { memoryModule } from "../modules/memory.js";
import { qaModule } from "../modules/qa.js";
import { chatHistoryModule } from "../modules/chat-history.js";
import { personaModule } from "../modules/persona.js";
import { moodModule } from "../modules/mood.js";
import { groupAdminModule, platformModule } from "../modules/platform.js";
import { proactiveModule } from "../modules/proactive.js";
import { voiceModule } from "../modules/voice.js";
import { stickerModule } from "../modules/stickers.js";
import { biliModule } from "../modules/bili.js";
import { qzoneModule } from "../modules/qzone.js";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { logger } from "alemonjs";
import { pathToFileURL } from "node:url";

// src/agent/modules.ts
const moduleId = /^[a-z][a-z0-9-]{0,63}$/u;
const toolName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u;
const getModuleConfig = (config) => {
	const value = config.modules || {};
	const result = {
		directory: value.directory || resolve(config.workspaceRoot, "..", "modules"),
		disabled: value.disabled || [],
		settings: value.settings || {},
		maxToolRounds: value.maxToolRounds ?? 8,
		maxToolContinuations: value.maxToolContinuations ?? 2
	};
	if (typeof result.directory !== "string" || !result.directory.trim() || !Array.isArray(result.disabled) || result.disabled.some((id) => typeof id !== "string" || !moduleId.test(id)) || !result.settings || typeof result.settings !== "object" || Array.isArray(result.settings) || Object.entries(result.settings).some(([id, settings]) => !moduleId.test(id) || !settings || typeof settings !== "object" || Array.isArray(settings)) || !Number.isSafeInteger(result.maxToolRounds) || result.maxToolRounds < 1 || result.maxToolRounds > 16 || !Number.isSafeInteger(result.maxToolContinuations) || result.maxToolContinuations < 0 || result.maxToolContinuations > 4) throw new Error("modules 配置无效。");
	return {
		...result,
		directory: resolve(result.directory)
	};
};
const snapshot = async (directory) => {
	const files = /* @__PURE__ */ new Map();
	let bytes = 0;
	const walk = async (relative = "", depth = 0) => {
		if (depth > 8) throw new Error("模块目录层级过深。");
		for (const entry of (await readdir(join(directory, relative))).sort()) {
			if (entry.startsWith(".") || entry === "node_modules") continue;
			const name = join(relative, entry);
			const info = await lstat(join(directory, name));
			if (info.isSymbolicLink()) throw new Error("模块目录不能包含符号链接。");
			if (info.isDirectory()) await walk(name, depth + 1);
			else if (info.isFile()) {
				if (files.size >= 200 || bytes + info.size > 5242880) throw new Error("模块文件总量超过限制。");
				const content = await readFile(join(directory, name));
				bytes += content.length;
				if (bytes > 5242880) throw new Error("模块文件总量超过限制。");
				files.set(name, content);
			} else throw new Error("模块目录只能包含普通文件。");
		}
	};
	await walk();
	if (!files.has("index.mjs")) throw new Error("模块缺少 index.mjs。");
	const hash = createHash("sha256");
	for (const [name, content] of files) hash.update(name).update("\0").update(String(content.length)).update("\0").update(content);
	return {
		revision: hash.digest("hex"),
		files
	};
};
var ModuleLease = class {
	modules;
	retire;
	released = false;
	constructor(modules, retire) {
		this.modules = modules;
		this.retire = retire;
		modules.forEach((module) => module.users++);
	}
	tools(context) {
		return this.modules.flatMap((module) => module.tools).filter((tool) => (!context.allowedTools || context.allowedTools.includes(tool.name)) && (!context.autonomous || tool.readOnly === true) && (!tool.available || tool.available(context)));
	}
	get transformsSystem() {
		return this.modules.some((module) => module.hooks.system.length > 0);
	}
	async system(prompt, context) {
		for (const module of this.modules) for (const handler of module.hooks.system) {
			context.signal.throwIfAborted();
			prompt = await handler(prompt, context);
			if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32e3) throw new Error("模块系统提示词无效或过长。");
		}
		return prompt;
	}
	async context(context) {
		const parts = [];
		for (const module of this.modules) for (const handler of module.hooks.context) {
			context.signal.throwIfAborted();
			const value = await handler(context);
			if (typeof value !== "string" || value.length > 16e3) throw new Error("模块上下文无效或过长。");
			if (value) parts.push(value);
		}
		const text = parts.join("\n\n");
		if (text.length > 32e3) throw new Error("模块上下文总量超过限制。");
		return text;
	}
	async prompt(input, context) {
		for (const module of this.modules) for (const handler of module.hooks.prompt) {
			context.signal.throwIfAborted();
			input = await handler(input, context);
			if (typeof input !== "string" && (!Array.isArray(input) || input.some((block) => !block || !["text", "image"].includes(block.type)))) throw new Error("模块消息内容无效。");
		}
		return input;
	}
	get transformsReplies() {
		return this.modules.some((module) => module.hooks.reply.length > 0);
	}
	async reply(text, context) {
		for (const module of this.modules) for (const handler of module.hooks.reply) {
			context.signal.throwIfAborted();
			text = await handler(text, context);
			if (typeof text !== "string" || text.length > 1e5) throw new Error("模块回复内容无效或过长。");
		}
		return text;
	}
	async activity(input, output, context) {
		for (const module of this.modules) for (const handler of module.hooks.activity) {
			context.signal.throwIfAborted();
			await handler({
				input,
				output
			}, context);
		}
	}
	async release() {
		if (this.released) return;
		this.released = true;
		for (const module of this.modules) {
			module.users--;
			await this.retire(module);
		}
	}
};
var ModuleRuntime = class {
	config;
	builtins;
	loaded = /* @__PURE__ */ new Map();
	statuses = [];
	refreshPending;
	closed = false;
	constructor(config, builtins = [
		filesModule(config),
		webModule(),
		mediaCapabilitiesModule(),
		personaModule(config),
		hobbiesModule(config),
		conversationModule(config),
		moodModule(config),
		affinityModule(config),
		interactionModule(config),
		opinionsModule(config),
		platformModule(config),
		exposeModule(),
		groupAdminModule(config),
		proactiveModule(config),
		voiceModule(config),
		stickerModule(),
		biliModule(config),
		qzoneModule(config),
		memoryModule(config),
		chatHistoryModule(config),
		qaModule(config),
		dictionaryModule(config),
		eventsModule(config)
	]) {
		this.config = config;
		this.builtins = builtins;
	}
	status() {
		return this.statuses.map((status) => ({ ...status }));
	}
	get isClosed() {
		return this.closed;
	}
	async acquire() {
		await this.refresh();
		if (this.closed) throw new Error("模块运行时已关闭，请重试当前请求。");
		return new ModuleLease([...this.loaded.values()], (module) => this.disposeRetired(module));
	}
	refresh() {
		if (this.closed) return Promise.reject(/* @__PURE__ */ new Error("模块运行时已关闭。"));
		if (this.refreshPending === void 0) this.refreshPending = this.reload().finally(() => {
			this.refreshPending = void 0;
		});
		return this.refreshPending;
	}
	async disposeRetired(module) {
		if (!module.retired || module.users > 0) return;
		for (const cleanup of module.cleanups.splice(0).reverse()) try {
			await cleanup();
		} catch {
			logger.warn({ module: module.definition.id }, "AgentLink module cleanup failed");
		}
	}
	async close() {
		this.closed = true;
		await this.refreshPending;
		const modules = [...this.loaded.values()];
		this.loaded.clear();
		for (const module of modules) {
			module.retired = true;
			await this.disposeRetired(module);
		}
	}
	async prepare(definition, revision, source, settings) {
		if (!definition || !moduleId.test(definition.id) || definition.apiVersion !== 1 || typeof definition.name !== "string" || typeof definition.version !== "string" || typeof definition.setup !== "function") throw new Error("模块定义或 API 版本无效。");
		const record = {
			definition,
			revision,
			source,
			tools: [],
			hooks: {
				system: [],
				context: [],
				prompt: [],
				reply: [],
				activity: []
			},
			cleanups: [],
			users: 0,
			retired: false
		};
		const dataDirectory = resolve(this.config.workspaceRoot, "..", "module-data", definition.id);
		await mkdir(dataDirectory, {
			recursive: true,
			mode: 448
		});
		const api = {
			id: definition.id,
			settings: Object.freeze(structuredClone(settings)),
			dataDirectory,
			tool: (tool) => {
				if (!tool || !toolName.test(tool.name) || typeof tool.description !== "string" || typeof tool.execute !== "function" || tool.readOnly !== void 0 && typeof tool.readOnly !== "boolean" || tool.parameters?.type !== "object" || tool.name === "agent_workspace" || record.tools.some((existing) => existing.name === tool.name)) throw new Error("工具定义无效或名称重复。");
				record.tools.push(tool);
			},
			on: (event, handler) => {
				if (!Object.hasOwn(record.hooks, event) || typeof handler !== "function") throw new Error("模块事件无效。");
				record.hooks[event].push(handler);
			},
			onDispose: (cleanup) => {
				record.cleanups.push(cleanup);
			}
		};
		try {
			await definition.setup(api);
		} catch (error) {
			record.retired = true;
			await this.disposeRetired(record);
			throw error;
		}
		return record;
	}
	async reload() {
		const options = getModuleConfig(this.config);
		const candidates = /* @__PURE__ */ new Map();
		for (const definition of this.builtins) candidates.set(definition.id, {
			definition,
			revision: `${definition.version}:${JSON.stringify(options.settings[definition.id] || {})}`,
			source: "builtin"
		});
		await mkdir(options.directory, {
			recursive: true,
			mode: 448
		});
		for (const entry of (await readdir(options.directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (!moduleId.test(entry.name) || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
			try {
				if (entry.isSymbolicLink()) throw new Error("模块目录不能是符号链接。");
				if (options.disabled.includes(entry.name)) {
					candidates.set(entry.name, {
						revision: "",
						source: "local"
					});
					continue;
				}
				const files = await snapshot(join(options.directory, entry.name));
				const revision = `${files.revision}:${JSON.stringify(options.settings[entry.name] || {})}`;
				const cached = this.loaded.get(entry.name);
				if (cached?.revision === revision && cached.source === "local") {
					candidates.set(entry.name, {
						definition: cached.definition,
						revision,
						source: "local"
					});
					continue;
				}
				const cacheRoot = resolve(this.config.workspaceRoot, "..", "module-cache");
				const target = join(cacheRoot, entry.name, files.revision);
				const staging = `${target}-${randomUUID()}`;
				await mkdir(staging, {
					recursive: true,
					mode: 448
				});
				try {
					for (const [name, data] of files.files) {
						const file = join(staging, name);
						await mkdir(resolve(file, ".."), {
							recursive: true,
							mode: 448
						});
						await writeFile(file, data, { mode: 384 });
					}
					await rename(staging, target).catch(async (error) => {
						if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
						await rm(staging, {
							recursive: true,
							force: true
						});
					});
					const definition = (await import(pathToFileURL(join(target, "index.mjs")).href)).default;
					if (definition?.id !== entry.name) throw new Error("模块 id 必须与目录名一致。");
					candidates.set(entry.name, {
						definition,
						revision,
						source: "local"
					});
				} finally {
					await rm(staging, {
						recursive: true,
						force: true
					});
				}
			} catch {
				candidates.set(entry.name, {
					revision: "",
					source: "local",
					error: "模块加载失败，请检查定义、文件和依赖。"
				});
			}
		}
		const statuses = [];
		const active = /* @__PURE__ */ new Set();
		const names = /* @__PURE__ */ new Set();
		for (const [id, candidate] of candidates) {
			const { definition, revision, source } = candidate;
			let current = this.loaded.get(id);
			const disabled = options.disabled.includes(id);
			if (current && (disabled || candidate.error || current.revision !== revision || current.source !== source)) {
				this.loaded.delete(id);
				current.retired = true;
				await this.disposeRetired(current);
				current = void 0;
			}
			if (disabled) {
				statuses.push({
					id,
					source,
					state: "disabled"
				});
				continue;
			}
			try {
				if (candidate.error) throw new Error(candidate.error);
				current ??= await this.prepare(definition, revision, source, options.settings[id] || {});
				for (const tool of current.tools) if (names.has(tool.name)) throw new Error("不同模块注册了同名工具。");
				current.tools.forEach((tool) => names.add(tool.name));
				this.loaded.set(id, current);
				active.add(id);
				statuses.push({
					id,
					source,
					state: "ready",
					name: definition.name,
					version: definition.version
				});
			} catch {
				if (current) {
					this.loaded.delete(id);
					current.retired = true;
					await this.disposeRetired(current);
				}
				statuses.push({
					id,
					source,
					state: "failed",
					error: "模块加载失败，请检查定义、文件、工具名称和依赖。"
				});
			}
		}
		for (const [id, module] of this.loaded) if (!active.has(id)) {
			this.loaded.delete(id);
			module.retired = true;
			await this.disposeRetired(module);
		}
		this.statuses = statuses;
	}
};
const executeTool = async (tool, args, context) => {
	context.signal.throwIfAborted();
	if (context.autonomous && tool.readOnly !== true) throw new Error("主动消息不能使用写入或管理工具。");
	if (tool.available && !tool.available(context)) throw new Error("当前会话没有这个工具的权限。");
	if (context.allowedTools && !context.allowedTools.includes(tool.name)) throw new Error("本次活动未开放这个工具。");
	validateArguments(tool.parameters, args);
	const safetyConfig = getDSHConfig();
	if (containsPrivateOutput(JSON.stringify(args), safetyConfig)) throw new Error("工具参数包含敏感信息，已阻止执行。");
	const result = await tool.execute(args, context);
	context.signal.throwIfAborted();
	if (containsPrivateOutput(JSON.stringify(result) || "", safetyConfig)) throw new Error("工具结果包含敏感信息，已阻止传递。");
	return result;
};
const globalState = globalThis;
const getModuleRuntime = async (config) => {
	const key = JSON.stringify(config);
	if (globalState.__agentLinkModules__?.key !== key || globalState.__agentLinkModules__.runtime.isClosed) {
		const previous = globalState.__agentLinkModules__?.runtime;
		const runtime = new ModuleRuntime(config);
		globalState.__agentLinkModules__ = {
			key,
			runtime
		};
		await previous?.close();
		return runtime;
	}
	return globalState.__agentLinkModules__.runtime;
};
const closeModuleRuntime = async () => {
	const current = globalState.__agentLinkModules__;
	globalState.__agentLinkModules__ = void 0;
	await current?.runtime.close();
};

export { ModuleLease, ModuleRuntime, closeModuleRuntime, executeTool, getModuleConfig, getModuleRuntime };