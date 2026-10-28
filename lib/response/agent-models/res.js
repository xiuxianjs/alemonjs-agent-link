import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getDSHCredentials } from "../../dsh/credentials.js";
import "../../dsh/client.js";
import { commandBubble } from "../bubble.js";
import { listAvailableModels } from "../../dsh/models.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-models/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
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
		const lines = ["可用模型", `当前模型：${credentials.model || config.model}`];
		const footer = "\n修改指引：/当前模型 模型ID";
		let length = lines.join("\n").length + 16 + 40;
		let displayed = 0;
		for (const model of models) {
			const line = `${displayed + 1}. ${model}`;
			if (length + line.length + 1 > config.maxMessageLength || lines.length >= 32) {
				lines.push(`- …其余 ${models.length - displayed} 个模型未展示。`);
				break;
			}
			lines.push(line);
			length += line.length + 1;
			displayed += 1;
		}
		lines.push(footer);
		await message.send({ format: commandBubble(lines.join("\n"), "模型列表", {
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