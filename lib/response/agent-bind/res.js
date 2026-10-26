import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-bind/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人可以绑定全群共用的模型凭证。") });
		return;
	}
	await message.send({ format: Format.create().addMarkdownOriginal("模型凭证仅从 `alemon.config.yaml` 读取。请在 `alemonjs-agent-link` 下设置 `apiKey` 和可选的 `baseUrl`，然后重启服务。") });
};

export { res_default as default };