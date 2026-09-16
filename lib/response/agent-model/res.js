import { getDSHCredentials, saveDSHCredentials } from "../../dsh/credentials.js";
import { configureDSHSupervisor } from "../../dsh/supervisor.js";
import { getDSHConfig } from "../../dsh/client.js";
import { listAvailableModels } from "../../dsh/models.js";
import { Format, logger, useEvent, useMessage, useRoute } from "alemonjs";

//#region src/response/agent-model/res.ts
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
	try {
		const credentials = await getDSHCredentials();
		if (!credentials) {
			await message.send({ format: Format.create().addMarkdownOriginal("尚未绑定模型凭证。请先发送 /agentbind <API_KEY> [BASE_URL]。") });
			return;
		}
		const config = getDSHConfig();
		if (!requestedModel) {
			await message.send({ format: Format.create().addMarkdownOriginal(`当前全局模型：\`${credentials.model || config.model}\`\n查看可用列表：/agentmodels`) });
			return;
		}
		if (!(await listAvailableModels(credentials)).includes(requestedModel)) {
			await message.send({ format: Format.create().addMarkdownOriginal("该模型不在当前服务返回的可用列表中。请先使用 /agentmodels 查看。") });
			return;
		}
		const updatedCredentials = {
			...credentials,
			model: requestedModel
		};
		await saveDSHCredentials(updatedCredentials);
		configureDSHSupervisor(config, updatedCredentials).start().catch((error) => logger.error({ err: error }, "DSH bridge restart after model change failed"));
		await message.send({ format: Format.create().addMarkdownOriginal(`已切换全局模型为 \`${requestedModel}\`，正在重新加载 DSH。请稍后发送 /agentstatus 确认就绪。`) });
	} catch {
		await message.send({ format: Format.create().addMarkdownOriginal("模型切换失败。请检查模型服务、凭证和可用模型列表。") });
	}
};

//#endregion
export { res_default as default };