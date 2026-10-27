import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-model/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("公共模型仅限机器人主人设置。") });
		return;
	}
	const requestedModel = String(route.rawArgs[0] ?? "").trim();
	const config = getDSHConfig();
	await message.send({ format: Format.create().addMarkdownOriginal(requestedModel ? `请将配置中的 \`alemonjs-agent-link.model\` 改为 \`${requestedModel}\`，保存即生效。` : `当前模型：\`${config.model}\`\n查看可用列表：/模型列表`) });
};

export { res_default as default };