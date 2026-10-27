import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-bind/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("公共密钥仅限机器人主人配置。") });
		return;
	}
	await message.send({ format: Format.create().addMarkdownOriginal("在 `alemon.config.yaml` 的 `alemonjs-agent-link` 中填写 `apiKey`，可选填 `baseUrl`。保存即生效，请勿在聊天中发送公共密钥。") });
};

export { res_default as default };