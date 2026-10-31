import { commandBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-unbind/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["private.message.create", "message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsPrivate) {
		await message.send({ format: commandBubble("公共密钥的配置与移除请由机器人主人在私聊查看指引。群内请勿发送真实密钥。", "公共密钥说明", {
			platform: event.Platform,
			actions: [{
				label: "我的权限",
				command: "/我的权限"
			}, {
				label: "额度说明",
				command: "/帮助 额度"
			}]
		}) });
		return;
	}
	if (!event.IsMaster) {
		await message.send({ format: commandBubble("公共密钥仅限机器人主人移除。管理自己的钥匙，请进入个人钥匙列表。", "移除密钥", {
			platform: event.Platform,
			actions: [{
				label: "个人钥匙",
				command: "/我的钥匙 私聊"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	await message.send({ format: commandBubble("这里只提供移除说明，尚未删除任何密钥。\n由主人删除配置中的 alemonjs-agent-link.apiKey 并保存，再查看当前模型核对。个人钥匙与群授权需在各自的钥匙列表管理。", "移除密钥", {
		platform: event.Platform,
		actions: [{
			label: "密钥配置",
			command: "/密钥配置"
		}, {
			label: "当前模型",
			command: "/当前模型"
		}]
	}) });
};

export { res_default as default };