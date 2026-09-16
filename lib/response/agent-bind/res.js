import { getDSHCredentials, saveDSHCredentials } from "../../dsh/credentials.js";
import { configureDSHSupervisor } from "../../dsh/supervisor.js";
import { getDSHConfig } from "../../dsh/client.js";
import { Format, logger, useEvent, useMessage, useRoute } from "alemonjs";

//#region src/response/agent-bind/res.ts
const usage = "仅机器人主人可在私聊绑定。用法：/agentbind <API_KEY> [BASE_URL]";
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人可以绑定全群共用的模型凭证。") });
		return;
	}
	const [apiKey, baseUrl] = route.rawArgs.map(String);
	if (!apiKey) {
		await message.send({ format: Format.create().addMarkdownOriginal(usage) });
		return;
	}
	try {
		if (baseUrl) new URL(baseUrl);
		const credentials = {
			apiKey,
			baseUrl,
			model: (await getDSHCredentials())?.model
		};
		await saveDSHCredentials(credentials);
		configureDSHSupervisor(getDSHConfig(), credentials).start().catch((error) => logger.error({ err: error }, "DSH bridge restart after credential binding failed"));
		await message.send({ format: Format.create().addMarkdownOriginal("模型凭证已绑定，正在重新加载 DSH。请稍后发送 /agentstatus 查看就绪状态。为降低 QQ 聊天记录风险，请立即手动删除刚才包含 API Key 的私聊消息。") });
	} catch (error) {
		logger.error({ err: error }, "DSH credential binding failed");
		await message.send({ format: Format.create().addMarkdownOriginal("绑定失败。请检查 API Key、可选 BASE_URL 以及系统密钥库是否可用。") });
	}
};

//#endregion
export { res_default as default };