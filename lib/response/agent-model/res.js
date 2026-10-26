import { getDSHConfig } from "../../dsh/client.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-model/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人可以切换全群模型。") });
		return;
	}
	const requestedModel = String(route.rawArgs[0] ?? "").trim();
	const config = getDSHConfig();
	await message.send({ format: Format.create().addMarkdownOriginal(requestedModel ? `模型由 \`alemon.config.yaml\` 的 \`alemonjs-agent-link.model\` 管理。请将其改为 \`${requestedModel}\` 并保存，后续请求自动生效，无需重启机器人。` : `当前配置模型：\`${config.model}\`\n查看可用列表：/agentmodels`) });
};

export { res_default as default };