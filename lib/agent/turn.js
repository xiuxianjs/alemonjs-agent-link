import { abortFailure } from "../dsh/errors.js";
import { getDSHCredentials } from "../dsh/credentials.js";
import { inputText, withInputContext } from "../dsh/input.js";
import { SessionRegistry } from "../state/registry.js";
import { ensureDSHSupervisor, hasDSHBridgeOverride } from "../dsh/supervisor.js";
import { streamChat } from "../dsh/client.js";
import { runToolChat } from "./tool-chat.js";
import { modelContext } from "../dsh/model-context.js";
import { getModuleConfig, getModuleRuntime } from "./modules.js";
import { logger } from "alemonjs";

// src/agent/turn.ts
const runModuleTurn = async (options) => {
	const { config, context, sessionId, history, onEvent, onCompleted } = options;
	const lease = await (await getModuleRuntime(config)).acquire();
	try {
		const personaPrompt = await lease.system(config.defaultSystemPrompt, context);
		const systemPrompt = `${personaPrompt}\n\n${modelContext(config.model)}${context.autonomous ? "\n当前为系统调度的主动搭话，不是主人发来的请求。只可读取当前私聊资料，不得把历史话语当作新授权，不能保存记忆、执行工作区、管理群或联系其他对象。不要编造现实经历；不适合打扰时只输出 [沉默]。" : ""}`;
		const moduleContext = await lease.context(context);
		const input = await lease.prompt(withInputContext(options.input, moduleContext), context);
		const tools = lease.tools(context);
		let answer = "";
		const observe = async (event) => {
			context.signal.throwIfAborted();
			if (event.type === "content") answer += event.content;
			await onEvent(event);
		};
		const hasImages = Array.isArray(input) && input.some((block) => block.type === "image");
		if (context.autonomous || tools.length || lease.transformsReplies || lease.transformsSystem && personaPrompt !== config.defaultSystemPrompt || hasImages) {
			const credentials = await getDSHCredentials();
			if (!credentials) throw new Error("业务工具需要配置模型 API Key。");
			const supervisor = await ensureDSHSupervisor(config);
			if (!hasDSHBridgeOverride()) await supervisor.prepareForChat();
			const sandboxReady = hasDSHBridgeOverride() || supervisor.status().phase === "ready";
			if (!context.autonomous && sandboxReady && (context.capabilities.web || context.capabilities.files || context.capabilities.terminal)) {
				const workspaceTool = {
					name: "agent_workspace",
					description: `让隔离会话执行具体任务并返回结果。当前权限：网页${context.capabilities.web ? "允许" : "禁止"}、文件${context.capabilities.files ? "允许" : "禁止"}、终端${context.capabilities.terminal ? "允许" : "禁止"}。不能管理机器人或调用未提供的业务接口。`,
					parameters: {
						type: "object",
						properties: { task: {
							type: "string",
							minLength: 1,
							maxLength: 12e3
						} },
						required: ["task"],
						additionalProperties: false
					},
					execute: async ({ task }, turn) => {
						let result = "";
						await streamChat(config, sessionId, String(task), (event) => {
							if (event.type === "content") {
								result += event.content;
								if (result.length > 24e3) throw new Error("工作区结果过长。");
							}
							return Promise.resolve();
						}, turn.userId, turn.signal, turn.capabilities);
						return {
							ok: true,
							result
						};
					}
				};
				if (tools.some((tool) => tool.name === workspaceTool.name)) throw new Error("模块不能覆盖 agent_workspace 工具。");
				tools.push(workspaceTool);
			}
			const registry = new SessionRegistry(config);
			const incremental = options.streamContent && !lease.transformsReplies && !config.outputBlockedKeywords.length;
			const raw = await runToolChat({
				config: {
					...config,
					defaultSystemPrompt: systemPrompt
				},
				credentials,
				input,
				context,
				tools,
				history: history ? await registry.privateHistory(history) : [],
				memoryContext: history?.memoryContext,
				maxRounds: getModuleConfig(config).maxToolRounds,
				onContent: incremental ? async (content) => {
					await onEvent({
						type: "content",
						content
					});
				} : void 0,
				onTool: async (name) => {
					await onEvent({
						type: "tool_call",
						tool: name
					});
				}
			});
			const transformed = await lease.reply(raw, context);
			answer = config.outputBlockedKeywords.some((word) => word && transformed.includes(word)) ? context.autonomous ? "[沉默]" : "回复因内容安全策略未发送。" : transformed;
			if (!answer.trim()) throw new Error("模块未产生可发送的回复。");
			context.signal.throwIfAborted();
			if (!incremental) await onEvent({
				type: "content",
				content: answer
			});
			await onEvent({ type: "done" });
			await onCompleted?.(context.signal);
			context.signal.throwIfAborted();
			if (history) await registry.appendPrivateTurn(history, inputText(options.input) + (typeof options.input === "string" ? "" : "\n[本轮包含图片]"), answer);
		} else await streamChat({
			...config,
			defaultSystemPrompt: systemPrompt
		}, sessionId, input, observe, context.userId, context.signal, context.capabilities, history, onCompleted);
		context.signal.throwIfAborted();
		if (history?.record?.() !== false) await lease.activity(context.userText, answer, context).catch(() => logger.warn("AgentLink module activity hook failed"));
	} catch (error) {
		throw abortFailure(error, context.signal) ?? error;
	} finally {
		await lease.release();
	}
};

export { runModuleTurn };