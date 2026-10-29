import { getDSHCredentials } from "../../dsh/credentials.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { commandBubble } from "../bubble.js";
import { listAvailableModels } from "../../dsh/models.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-models/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const [route] = useRoute();
	if (!event.IsMaster) {
		await message.send({ format: commandBubble("公共模型列表仅限机器人主人查看。", "模型列表", { platform: event.Platform }) });
		return;
	}
	try {
		const credentials = await getDSHCredentials();
		if (!credentials) {
			await message.send({ format: commandBubble("尚未配置模型密钥，请查看 /密钥配置。", "模型列表", {
				platform: event.Platform,
				actions: [
					{
						label: "当前模型",
						command: "/当前模型"
					},
					{
						label: "密钥配置",
						command: "/密钥配置"
					},
					{
						label: "模型列表",
						command: "/模型列表"
					}
				]
			}) });
			return;
		}
		const config = getDSHConfig();
		const models = await listAvailableModels(credentials);
		const current = credentials.model || config.model;
		const pageSize = 8;
		const pages = Math.max(1, Math.ceil(models.length / pageSize));
		const requested = Number.parseInt(String(route.rawArgs[0] ?? "1"), 10);
		const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1;
		const start = (page - 1) * pageSize;
		const table = [
			"| # | 模型 | 状态 |",
			"| --- | --- | --- |",
			...models.slice(start, start + pageSize).map((model, index) => `| ${start + index + 1} | ${model} | ${model === current ? "当前" : "-"} |`)
		];
		const nav = [
			...page > 1 ? [{
				label: "上一页",
				command: `/模型列表 ${page - 1}`
			}] : [],
			...page < pages ? [{
				label: "下一页",
				command: `/模型列表 ${page + 1}`
			}] : [],
			{
				label: "刷新",
				command: "/模型列表"
			}
		];
		const intro = models.length ? `当前模型：${current}；共 ${models.length} 个。` : "没有可用模型。";
		await message.send({ format: commandBubble(`${intro}\n\n${table.join("\n")}`, "模型列表", {
			platform: event.Platform,
			layout: "inline",
			actions: nav
		}) });
	} catch {
		await message.send({ format: commandBubble("模型列表读取失败，请检查密钥和服务地址。", "模型列表", {
			platform: event.Platform,
			actions: [{
				label: "密钥配置",
				command: "/密钥配置"
			}, {
				label: "重试",
				command: "/模型列表"
			}]
		}) });
	}
};

export { res_default as default };