import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SessionRegistry } from "../../state/registry.js";
import "../../dsh/client.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-policy/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	if (event.IsPrivate) {
		await message.send({ format: Format.create().addMarkdownOriginal("请到需要管理的目标群里使用 `/agentpolicy`。") });
		return;
	}
	if (!event.ChannelId || !event.IsMaster) {
		await message.send({ format: Format.create().addMarkdownOriginal("只有机器人主人可在群内管理 Agent 策略。") });
		return;
	}
	try {
		const registry = new SessionRegistry(getDSHConfig());
		const requested = String(route.rawArgs[0] || "status").toLowerCase();
		if (requested === "status") {
			await message.send({ format: Format.create().addMarkdownOriginal(`当前群策略：\n\n- 聊天：${(await registry.policy(event.ChannelId)).chat ? "开启" : "关闭"}\n- 网页：${(await registry.policy(event.ChannelId)).web ? "开启" : "关闭"}\n- 文件：${(await registry.policy(event.ChannelId)).files ? "开启" : "关闭"}\n- 终端：${(await registry.policy(event.ChannelId)).terminal ? "开启" : "关闭"}`) });
			return;
		}
		const enabled = String(route.rawArgs[1] || "").toLowerCase();
		if (![
			"chat",
			"web",
			"files",
			"terminal"
		].includes(requested) || !["on", "off"].includes(enabled)) {
			await message.send({ format: Format.create().addMarkdownOriginal("用法：/agentpolicy status | chat|web|files|terminal on|off") });
			return;
		}
		const policy = await registry.policy(event.ChannelId);
		await registry.setPolicy(event.ChannelId, {
			...policy,
			[requested]: enabled === "on"
		});
		await resetGroupSession(event.ChannelId, getDSHConfig());
		await message.send({ format: Format.create().addMarkdownOriginal(`已${enabled === "on" ? "开启" : "关闭"}当前群的 ${requested} 权限，并开始新的隔离会话。`) });
	} catch {
		await message.send({ format: Format.create().addMarkdownOriginal("策略暂时无法读取，请稍后再试。") });
	}
};

export { res_default as default };