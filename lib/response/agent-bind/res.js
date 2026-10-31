import { personalKeyGuide } from "../../billing/help.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-bind/res.ts
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
		await message.send({ format: commandBubble(`公共密钥仅限机器人主人配置。个人使用请按下面操作：\n\n${personalKeyGuide}`, "密钥配置", {
			platform: event.Platform,
			actions: [{
				label: "个人密钥",
				command: "/我的钥匙 私聊"
			}, {
				label: "额度教程",
				command: "/帮助 额度"
			}]
		}) });
		return;
	}
	await message.send({ format: commandBubble("这里只提供配置说明，尚未修改公共密钥。\n由主人在 alemon.config.yaml 的 alemonjs-agent-link 中填写 apiKey，可选填 baseUrl。保存后可查看当前模型核对，请勿在聊天中发送公共密钥。", "密钥配置", {
		platform: event.Platform,
		actions: [{
			label: "模型列表",
			command: "/模型列表"
		}, {
			label: "当前模型",
			command: "/当前模型"
		}]
	}) });
};

export { res_default as default };