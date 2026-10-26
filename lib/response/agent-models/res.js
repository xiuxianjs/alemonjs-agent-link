import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getDSHCredentials } from "../../dsh/credentials.js";
import "../../dsh/client.js";
import { listAvailableModels } from "../../dsh/models.js";
import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-models/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人可以查看全群模型列表。") });
		return;
	}
	try {
		const credentials = await getDSHCredentials();
		if (!credentials) {
			await message.send({ format: Format.create().addMarkdownOriginal("尚未配置模型凭证。请在 `alemon.config.yaml` 的 `alemonjs-agent-link` 下设置 `apiKey`。") });
			return;
		}
		const config = getDSHConfig();
		const models = await listAvailableModels(credentials);
		const lines = ["# 可用模型", `当前模型：\`${credentials.model || config.model}\``];
		let length = lines.join("\n").length;
		let displayed = 0;
		for (const model of models) {
			const line = `- \`${model}\``;
			if (length + line.length + 1 > config.maxMessageLength || lines.length >= 32) {
				lines.push(`- …其余 ${models.length - displayed} 个模型未展示。`);
				break;
			}
			lines.push(line);
			length += line.length + 1;
			displayed += 1;
		}
		lines.push("\n修改模型：编辑 `alemon.config.yaml` 中的 `alemonjs-agent-link.model` 并保存，后续请求自动生效，无需重启机器人。配置指引：`/agenthelp`。");
		await message.send({ format: Format.create().addMarkdownOriginal(lines.join("\n")) });
	} catch {
		await message.send({ format: Format.create().addMarkdownOriginal("无法读取模型列表。请确认 API Key、BASE_URL 和模型服务状态。") });
	}
};

export { res_default as default };