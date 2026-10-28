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
				label: "管理说明",
				command: "/帮助 管理"
			}]
		}) });
		return;
	}
	const requestedModel = String(route.rawArgs[0] ?? "").trim();
	const config = getDSHConfig();
	const pool = getCredentialPool(config);
	const poolText = pool ? `\n端点池：${pool.status.map((item) => `${item.id}${item.disabled ? "（停用）" : item.cooldownUntil > Date.now() ? "（冷却）" : item.active ? `（${item.active} 在途）` : ""}`).join("、")}` : "";
	await message.send({ format: commandBubble(requestedModel ? `请将配置中的 alemonjs-agent-link.model 改为 ${requestedModel}，保存即生效。` : `当前模型：${config.model}${poolText}\n查看可用列表：/模型列表`, "当前模型", {
		platform: event.Platform,
		actions: [{
			label: "模型列表",
			command: "/模型列表"
		}, {
			label: "密钥配置",
			command: "/密钥配置"
		}]
	}) });
};

export { res_default as default };