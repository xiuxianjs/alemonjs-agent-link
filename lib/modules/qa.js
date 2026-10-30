import { isCommandQuestion, isQaQuestion, isWhyQuestion } from "../qa/detection.js";
import { getQAStore } from "../qa/store.js";
import { qaOptions } from "../qa/options.js";
import { logger } from "alemonjs";

// src/modules/qa.ts
const compactQa = (item) => ({
	id: item.id,
	question: item.question,
	answer: item.answer,
	kind: item.kind,
	source: item.origin,
	confidence: item.confidence,
	hits: item.hits
});
const explicitQaRequest = (text) => /(记住|记一下|记下来|保存|录入|写进|加入).{0,30}(问|答|为什么|为何|怎么|用法|指令|命令|是不是|有没有|这句|这条|这个)/u.test(text) || /(以后|之后|下次).{0,20}(有人问|问到|问起)/u.test(text);
const qaModule = (config) => ({
	id: "qa",
	name: "问答库",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const store = getQAStore(config);
		const options = qaOptions(config);
		const pending = /* @__PURE__ */ new Map();
		const prunePending = () => {
			const cutoff = Date.now() - 3e5;
			for (const [key, value] of pending) if (value.at < cutoff) pending.delete(key);
			while (pending.size > 128) pending.delete(pending.keys().next().value);
		};
		const takePending = (context) => {
			const key = context.requestId || context.inputId;
			if (!key) return;
			const value = pending.get(key);
			pending.delete(key);
			return value ? {
				matches: value.matches,
				kind: value.kind
			} : void 0;
		};
		api.on("context", (context) => {
			if (!context.platform || !context.channelId || context.autonomous) return "";
			const why = isWhyQuestion(context.userText);
			const command = !why && isCommandQuestion(context.userText);
			if (!why && !command) return "";
			const kind = why ? "why" : "command";
			store.observe(context);
			const matches = store.search(context, context.userText, options.recallLimit, {
				threshold: options.matchThreshold,
				kind
			});
			if (matches.length && (context.requestId || context.inputId)) {
				prunePending();
				pending.set(context.requestId || context.inputId, {
					matches,
					kind,
					at: Date.now()
				});
			}
			if (!matches.length) return kind === "why" ? "本轮是“为什么/为何”类疑问，问答库没有直接匹配的条目。请用大白话和日常比喻解释，少用配置名、英文术语和内部实现；依据实际配置、文档和已确认事实回答，不确定就说明不确定，不要编造，也不要在回复里提到问答库或检索过程。" : "本轮像在问指令用法，问答库没有直接匹配的条目。请用大白话说明怎么用，命令和参数保留原样；不确定就说明不确定，不要编造不存在的命令，也不要在回复里提到问答库或检索过程。";
			return [
				"以下是问答库中与本轮问题匹配的参考解答。优先采用与问题最接近的条目，直接据此回答；除非用户提供相反事实，不要换成其他说法。用大白话和日常比喻解释，少用配置名、英文术语和内部实现；必须提到的命令保留原样。不要在回复里提到问答库、检索过程，也不要照读编号或 JSON。",
				"builtin / explicit 条目是已确认的解答；learned 条目来自本会话此前的回答，可能过时，若与当前事实或用户纠正冲突，以事实为准并说明差异。",
				JSON.stringify({ hits: matches.map(compactQa) })
			].join("\n");
		});
		api.on("activity", (activity, context) => {
			if (!options.autoRecord || context.autonomous || !context.platform || !context.channelId || !isQaQuestion(context.userText)) return;
			const question = context.userText.trim().slice(0, 300);
			const answer = activity.output.trim();
			if (question.length < 2 || answer.length < 6 || answer.length > 1200) return;
			if (/(糟糕，网线断了|非常抱歉，我网卡没流量了|服务暂时不可用|模型服务暂时不可用|请稍后再试|回复因内容安全策略未发送|\[沉默\])/u.test(answer)) return;
			try {
				const cached = takePending(context);
				const kind = cached?.kind ?? (isWhyQuestion(context.userText) ? "why" : "command");
				const matches = cached?.matches.length ? cached.matches : store.search(context, question, 1, {
					threshold: options.matchThreshold,
					record: false,
					kind
				});
				if (matches.length) store.recordAsked(context, {
					userId: context.userId,
					question,
					answer,
					matchedId: matches[0].id
				});
				else {
					store.learn(context, {
						question,
						answer
					}, options.maxEntries);
					store.recordAsked(context, {
						userId: context.userId,
						question,
						answer
					});
				}
			} catch {
				logger.warn("QA library record failed");
			}
		});
		api.tool({
			name: "search_qa",
			readOnly: true,
			description: "检索当前会话与全局问答库，返回已确认的“为什么/为何”或“指令用法”解答。用户追问同类原因、命令怎么用、权限怎么开时先查这里；没有命中时不要编造库中不存在的内容。",
			parameters: {
				type: "object",
				additionalProperties: false,
				properties: {
					query: {
						type: "string",
						maxLength: 500
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 10
					}
				}
			},
			available: (context) => Boolean(context.platform && context.channelId),
			execute: (args, context) => {
				const matches = store.search(context, String(args.query || context.userText), Number(args.limit || options.recallLimit), {
					threshold: options.matchThreshold,
					record: false
				});
				return Promise.resolve({
					ok: true,
					items: matches.map(compactQa),
					notice: "问答库只覆盖已经记录的问题；未命中不代表没有答案，请继续按事实回答。转述时用大白话和日常比喻，少用配置名和内部术语。"
				});
			}
		});
		api.tool({
			name: "remember_qa",
			description: "主人在本轮明确要求保存问答时，把问题与标准答案写入问答库。session 只对当前群或私聊生效；global 对所有会话生效，仅建议保存与机器人能力、群规等公共问题。",
			parameters: {
				type: "object",
				additionalProperties: false,
				required: ["question", "answer"],
				properties: {
					question: {
						type: "string",
						minLength: 2,
						maxLength: 300
					},
					answer: {
						type: "string",
						minLength: 1,
						maxLength: 1200
					},
					keywords: {
						type: "array",
						maxItems: 10,
						items: {
							type: "string",
							minLength: 1,
							maxLength: 30
						}
					},
					scope: {
						type: "string",
						enum: ["session", "global"]
					}
				}
			},
			available: (context) => Boolean(context.owner && !context.autonomous && context.platform && context.channelId),
			execute: (args, context) => {
				if (!explicitQaRequest(context.userText)) return Promise.resolve({
					ok: false,
					message: "主人没有明确要求保存问答，请先确认。"
				});
				const target = args.scope === "global" ? "global" : context;
				const item = store.addExplicit(target, {
					question: String(args.question || ""),
					answer: String(args.answer || ""),
					keywords: Array.isArray(args.keywords) ? args.keywords.map(String) : [],
					tags: []
				});
				return Promise.resolve({
					ok: true,
					item: compactQa(item),
					message: args.scope === "global" ? "已写入全局问答库。" : "已写入当前会话问答库。"
				});
			}
		});
	}
});

export { qaModule };