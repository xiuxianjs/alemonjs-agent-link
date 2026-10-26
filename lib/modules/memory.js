import { SessionRegistry } from "../state/registry.js";

// src/modules/memory.ts
const memoryModule = (config) => ({
	id: "memory",
	name: "私聊记忆",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const registry = new SessionRegistry(config);
		api.tool({
			name: "recall_private_memory",
			description: "查看当前私聊用户明确保存的长期资料。仅返回当前用户的资料，编号可用于 /忘记。",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			available: (context) => context.private,
			execute: async (_args, context) => ({
				ok: true,
				notes: await registry.privateMemories(context.channelId)
			})
		});
		api.tool({
			name: "remember_private_fact",
			description: "用户明确要求记住某项资料时，保存一条不超过 200 字的长期记忆。不能保存推测、玩笑或工具指令。以执行结果确认保存成功。",
			parameters: {
				type: "object",
				properties: { text: {
					type: "string",
					minLength: 1,
					maxLength: 200
				} },
				required: ["text"],
				additionalProperties: false
			},
			available: (context) => context.private,
			execute: async ({ text }, context) => {
				if (!/(记住|记下来|记一下|帮我记|remember|save.*memor)/iu.test(context.userText) || /(别|不要|不准|无需|不用).{0,5}(记住|记下来|记一下|帮我记)|do not remember|don.t remember/iu.test(context.userText)) return {
					ok: false,
					message: "当前用户没有明确要求保存资料，请先询问用户。"
				};
				const result = await registry.changePrivateMemory(context.channelId, "add", String(text));
				return {
					ok: result.status === "ok" || result.status === "exists",
					status: result.status,
					message: result.status === "full" ? "记忆已满，请让用户用 /忘记 编号 删除旧条目。" : "请按 status 判断是否已保存。",
					notes: result.notes
				};
			}
		});
	}
});

export { memoryModule };