import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getCredentialPool } from "../../credentials/pool.js";
import "../../dsh/client.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-model/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: commandBubble("公共模型仅限机器人主人设置。", "当前模型", {
			platform: event.Platform,
			actions: [{
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	const requestedModel = String(route.rawArgs[0] ?? "").trim();
	const config = getDSHConfig();
	const pool = getCredentialPool(config);
	if (route.rawArgs.length > 1) {
		await message.send({ format: commandBubble("一次只能指定一个模型名称。请先查看可用模型，再选择要配置的模型。", "当前模型", {
			platform: event.Platform,
			actions: [{
				label: "模型列表",
				command: "/模型列表"
			}, {
				label: "返回状态",
				command: "/当前模型"
			}]
		}) });
		return;
	}
	const rows = pool?.status || [];
	const poolText = pool ? rows.length ? `额度轮转：共 ${rows.length} 个端点，当前 ${rows.reduce((sum, item) => sum + item.active, 0)} 个请求处理中。\n各端点的状态和操作请进入「额度轮转」查看。` : "额度轮转暂时没有端点。" : "当前使用配置中的单个密钥，未启用端点池。";
	await message.send({ format: commandBubble(requestedModel ? `尚未修改模型。\n请在配置文件中将 alemonjs-agent-link.model 改为 ${requestedModel}，保存后生效。` : `当前模型：${config.model}\n\n${poolText}`, "当前模型", {
		platform: event.Platform,
		layout: "inline",
		actions: [
			{
				label: "模型列表",
				command: "/模型列表"
			},
			{
				label: "额度轮转",
				command: "/额度轮转"
			},
			{
				label: "密钥配置",
				command: "/密钥配置"
			}
		]
	}) });
};

export { res_default as default };