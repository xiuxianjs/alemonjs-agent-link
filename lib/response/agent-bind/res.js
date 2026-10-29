import { personalKeyGuide } from "../../billing/help.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-bind/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
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
	await message.send({ format: commandBubble("在 alemon.config.yaml 的 alemonjs-agent-link 中填写 apiKey，可选填 baseUrl。保存即生效，请勿在聊天中发送公共密钥。", "密钥配置", {
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