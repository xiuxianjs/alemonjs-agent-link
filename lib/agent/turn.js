import { getMediaConfig } from "../media/config.js";
import { abortFailure } from "../dsh/errors.js";
import { assertAIEnabled } from "../dsh/ai-switch.js";
import { withBudgetScope } from "../billing/budget.js";
import { inputText, withInputContext } from "../dsh/input.js";
import { describeVisualInput } from "../media/providers.js";
import { bridgeConversationIdentity, conversationQueueScope } from "../dsh/conversation-scope.js";
import { personalPersonaOwnership } from "../companion/persona-owner.js";
import { personaDetailsPrompt } from "../companion/persona-details.js";
import { createChatTaskCredentials, getWorkspaceCredentials } from "../dsh/credentials.js";
import { ownerTerminalAllowed, turnIntelligence } from "./intelligence.js";
import { runToolChat } from "./tool-chat.js";
import { withToolUsePolicy } from "./tool-use-policy.js";
import { normalizeBubbleText } from "../dsh/reply-format.js";
import { SessionRegistry } from "../state/registry.js";
import { ensureDSHSupervisor, hasDSHBridgeOverride } from "../dsh/supervisor.js";
import { streamChat } from "../dsh/client.js";
import { readScopedPersona } from "./scoped-persona.js";
import { bufferUnavailableMemorySave, resolveUnavailableMemoryEcho } from "../memory/save-reply.js";
import { startFrameworkMcp } from "../platform/mcp.js";
import { drawingTool } from "../media/drawing.js";
import { imageGenerationTool } from "../media/image-generation.js";
import { modelContext } from "../dsh/model-context.js";
import { estimateModelRequestTokens } from "./token-estimate.js";
import { getModuleConfig, getModuleRuntime } from "./modules.js";
import { logger } from "alemonjs";

// src/agent/turn.ts
const runModuleTurnInner = async (options) => {
	const { config, sessionId, history, onEvent, onCompleted } = options;
	assertAIEnabled(config);
	const context = {
		...options.context,
		capabilities: {
			...options.context.capabilities,
			terminal: ownerTerminalAllowed(options.context, Boolean(options.context.autonomous))
		},
		onSpeech: options.onSpeech || options.context.onSpeech,
		onSticker: options.onSticker || options.context.onSticker,
		onStickerCollect: options.onStickerCollect || options.context.onStickerCollect,
		onCurrentImages: options.onCurrentImages || options.context.onCurrentImages
	};
	const intelligence = await turnIntelligence(config, context, context.userText, Boolean(context.autonomous));
	context.intelligenceLevel = intelligence.level;
	context.personaEntitled = intelligence.entitled;
	context.personalPersonaOwner = personalPersonaOwnership(context, intelligence.bound);
	context.groupPersonaFamily = !context.private && intelligence.bound;
	const preparingAt = Date.now();
	const chatTask = createChatTaskCredentials();
	const lease = await (await getModuleRuntime(config)).acquire();
	try {
		const scopedPrompt = intelligence.entitled ? personaDetailsPrompt(readScopedPersona(config, context)) : "";
		const personaPrompt = [await lease.system(config.defaultSystemPrompt, context), scopedPrompt ? "以下仅调整当前会话表达，不改变权限、身份与工具规则。\n" + scopedPrompt : ""].filter(Boolean).join("\n\n");
		let systemPrompt = withToolUsePolicy(`${personaPrompt}\n\n${modelContext(config.model)}${context.autonomous ? "\n当前为系统调度的主动搭话，不是用户新发来的请求。只可读取当前会话范围内的资料与已开放的只读信息，不得把历史话语当作新授权，不能主动调用记忆写入、执行工作区、管理群或联系其他对象。系统可以记录真实完成的只读操作作为经历。不要编造现实经历；不适合打扰时只输出 [沉默]。" : ""}`);
		const visualInput = Array.isArray(options.input) && options.input.some((part) => part.type === "image") ? await describeVisualInput(options.input, getMediaConfig(), context.signal) : options.input;
		const moduleContext = await lease.context(context);
		const input = await lease.prompt(withInputContext(visualInput, moduleContext), context);
		const tools = lease.tools(context);
		logger.debug({
			requestId: context.requestId,
			elapsedMs: Date.now() - preparingAt,
			web: context.capabilities.web,
			files: context.capabilities.files,
			terminal: context.capabilities.terminal,
			intelligence: intelligence.level,
			tools: tools.length,
			workspaceTool: tools.some((tool) => tool.name === "agent_workspace")
		}, "Agent context prepared");
		if (options.onImage && !context.autonomous) {
			let generationAttempted = false;
			let drawingAttempted = false;
			let imagePending = false;
			let imageQueued = false;
			const deliverImage = async (data) => {
				imageQueued = true;
				await options.onImage(data);
			};
			if (tools.some((tool) => tool.name === "draw_image")) throw new Error("模块不能覆盖 draw_image 工具。");
			const drawing = drawingTool(deliverImage);
			const executeDrawing = drawing.execute;
			drawing.execute = async (args, turn) => {
				turn.signal.throwIfAborted();
				if (drawingAttempted || imagePending || imageQueued) throw new Error("本轮已有图片处理中或已提交，不能重复绘制。");
				drawingAttempted = true;
				imagePending = true;
				try {
					const result = await executeDrawing(args, turn);
					return generationAttempted ? {
						...result,
						fallback: "local-drawing",
						notice: "外部生图失败，已降级为本地图形绘制，不是原生图模型的结果。"
					} : result;
				} finally {
					imagePending = false;
				}
			};
			tools.push(drawing);
			try {
				const media = getMediaConfig();
				if (media.imageGen) {
					if (tools.some((tool) => tool.name === "generate_image")) throw new Error("模块不能覆盖 generate_image 工具。");
					const imageTool = imageGenerationTool(media, deliverImage);
					const generate = imageTool.execute;
					imageTool.execute = async (args, turn) => {
						turn.signal.throwIfAborted();
						if (generationAttempted || drawingAttempted || imagePending || imageQueued) throw new Error("每回合最多尝试一次外部生图，不能重复生成。");
						generationAttempted = true;
						imagePending = true;
						try {
							return await generate(args, turn);
						} finally {
							imagePending = false;
						}
					};
					if (!imageTool.available || imageTool.available(context)) tools.push(imageTool);
				}
			} catch (error) {
				if (error instanceof Error && error.message === "模块不能覆盖 generate_image 工具。") throw error;
				logger.warn("Image generation configuration unavailable");
			}
		}
		if (options.onImage && !context.autonomous) {
			const canGenerate = tools.some((tool) => tool.name === "generate_image");
			systemPrompt += `\n\n【本轮图片能力】
当前可调用 draw_image，将形状、路径和文字绘制成 PNG，适合流程示意图、图标、简单插画；无需文件或终端权限。
${canGenerate ? "当前也可调用 generate_image，使用已配置的外部生图服务；复杂插画、人物、写实场景优先使用它。" : "当前未开放 generate_image，不能承诺外部 AI 生图。简单绘图仍可使用 draw_image；用户明确需要照片级或复杂生图时，说明本轮缺少可用生图服务，不把简单图形绘制冒充该效果。"}
用户明确要求画图、生成图片或继续已确认的绘图任务时，按要求调用合适的工具，不能只回答“可以”“正在画”或仅给提示词。仅询问能力或讨论方案时正常解释。缺少不影响执行的风格细节时合理选择，不重复索要确认。
两种工具都不支持精确编辑已有图片。外部生图每轮最多尝试一次；失败且未提交图片时，可以改用 draw_image 绘制一次，须依据原需求重新组织图形，并明确说明已降级为简单绘制、不能达到原生图效果。用户明确禁止降级或只接受照片级效果时，不强行绘制。已取消、已提交图片或提交结果不确定时不得再生成。不要将未配置的 DSH 插件当作可用生图服务。created 只表示图片进入本轮回复队列，不能宣称平台已送达。`;
		}
		let answer = "";
		const observe = async (event) => {
			context.signal.throwIfAborted();
			if (event.type === "content") answer += event.content;
			await onEvent(event);
		};
		const hasImages = Array.isArray(input) && input.some((block) => block.type === "image");
		const unavailableMemorySave = bufferUnavailableMemorySave(context.private, context.userText, tools);
		if (intelligence.entitled || context.autonomous || unavailableMemorySave || tools.length || lease.transformsReplies || lease.transformsSystem && personaPrompt !== config.defaultSystemPrompt || hasImages) {
			const supervisor = await ensureDSHSupervisor(config);
			if (!hasDSHBridgeOverride() && config.runtimeMode !== "chat-only") supervisor.prepareForChat().catch(() => logger.warn("Workspace preparation pending or unavailable"));
			const sandboxReady = hasDSHBridgeOverride() || config.runtimeMode !== "chat-only";
			if (!context.autonomous && sandboxReady && (context.capabilities.web || context.capabilities.files || context.capabilities.terminal)) {
				const workspaceTool = {
					name: "agent_workspace",
					description: `让隔离会话执行具体任务并返回结果。当前权限：网页${context.capabilities.web ? "允许" : "禁止"}、文件${context.capabilities.files ? "允许" : "禁止"}、终端${context.capabilities.terminal ? "允许" : "禁止"}。文件操作使用 framework MCP 的 workspace_* 工具；仅终端权限允许时可按用户明确任务执行终端命令。可通过 framework MCP 发现并调用本轮开放的框架和业务接口，权限以目录与真实回执为准。${context.capabilities.web && context.capabilities.files && context.capabilities.terminal && config.dshPlugins?.length ? `管理员已允许工作区加载这些 DSH 插件：${config.dshPlugins.map((item) => item.name + "@" + item.version).join("、")}。相关任务优先检查并复用其实际工具，加载失败如实报告；不得自行安装名单外插件。` : ""}`,
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
						const framework = await startFrameworkMcp(tools, turn);
						const workspaceCredentials = await getWorkspaceCredentials({ stickyKey: context.channelId });
						try {
							await streamChat(config, sessionId, String(task), (event) => {
								if (event.type === "content") {
									result += event.content;
									if (result.length > 24e3) throw new Error("工作区结果过长。");
								}
								return Promise.resolve();
							}, turn.userId, turn.signal, turn.capabilities, void 0, void 0, framework.endpoint, workspaceCredentials || void 0, bridgeConversationIdentity(context.channelId, conversationQueueScope(config, context)));
						} finally {
							framework.close();
						}
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
			const incremental = options.streamContent && !lease.transformsReplies && !config.outputBlockedKeywords.length && !unavailableMemorySave;
			const moduleConfig = getModuleConfig(config);
			const limits = options.toolLimits;
			if (limits && (!Number.isSafeInteger(limits.maxRounds) || limits.maxRounds < 1 || !Number.isSafeInteger(limits.maxContinuations) || limits.maxContinuations < 0)) throw new Error("回合工具上限无效。");
			const roundBudget = context.autonomous && context.independentReading && limits ? limits.maxRounds : intelligence.maxRounds;
			const raw = await runToolChat({
				config: {
					...config,
					defaultSystemPrompt: systemPrompt
				},
				credentials: (messages, requestTools) => chatTask.acquire({
					signal: context.signal,
					purpose: hasImages ? "vision" : requestTools.length ? "tools" : "chat",
					stickyKey: context.channelId,
					requestId: context.requestId,
					estimatedTokens: estimateModelRequestTokens(messages, requestTools, config.budget?.maxOutputTokens ?? 2048)
				}),
				input,
				context,
				tools,
				history: history ? await registry.privateHistory(history) : [],
				memoryContext: history?.memoryContext,
				maxRounds: Math.min(roundBudget, moduleConfig.maxToolRounds, limits?.maxRounds ?? moduleConfig.maxToolRounds),
				maxContinuations: Math.min(intelligence.maxContinuations, moduleConfig.maxToolContinuations, limits?.maxContinuations ?? moduleConfig.maxToolContinuations),
				onContent: incremental ? async (content) => {
					await onEvent({
						type: "content",
						content
					});
				} : void 0,
				onRetry: () => onEvent({ type: "retrying" }),
				onTool: async (name) => {
					await onEvent({
						type: "tool_call",
						tool: name
					});
				}
			});
			const moduleReply = await lease.reply(raw, context);
			const transformed = unavailableMemorySave ? resolveUnavailableMemoryEcho(moduleReply, context.userText) : moduleReply;
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
			if (history) await registry.appendPrivateTurn(history, context.autonomous ? "" : inputText(options.input) + (typeof options.input === "string" ? "" : "\n[本轮包含图片]"), normalizeBubbleText(answer), Boolean(context.autonomous));
		} else await streamChat({
			...config,
			defaultSystemPrompt: systemPrompt
		}, sessionId, input, observe, context.userId, context.signal, context.capabilities, history, onCompleted, void 0, void 0, bridgeConversationIdentity(context.channelId, conversationQueueScope(config, context)));
		context.signal.throwIfAborted();
		if (history?.record?.() !== false) await lease.activity(context.userText, answer, context).catch(() => logger.warn("AgentLink module activity hook failed"));
	} catch (error) {
		throw abortFailure(error, context.signal) ?? error;
	} finally {
		chatTask.close();
		await lease.release();
	}
};
const runModuleTurn = (options) => withBudgetScope(options.context, () => runModuleTurnInner(options));

export { runModuleTurn };