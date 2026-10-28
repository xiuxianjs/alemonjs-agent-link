import { setAIEnabled } from "../../dsh/ai-switch.js";
import { noticeBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/ai-switch/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const [message] = useMessage();
	const event = context.current;
	const enabled = route.key === "开启";
	let text;
	try {
		if (enabled && route.rawArgs.length) throw new Error("开启用法：/开启");
		text = setAIEnabled(event.IsMaster === true, enabled, route.rawArgs.join(" "));
	} catch (error) {
		text = error instanceof Error && (error.message.startsWith("只有") || error.message.startsWith("关闭原因") || error.message.startsWith("开启用法")) ? error.message : "AI 开关未能保存，请检查服务器配置文件。";
	}
	await message.send({ format: noticeBubble(text, {
		platform: event.Platform,
		title: enabled ? "已开启" : "已关闭",
		actions: enabled ? [{
			label: "服务状态",
			command: "/状态"
		}, {
			label: "管理说明",
			command: "/帮助 管理"
		}] : [{
			label: "恢复请求",
			command: "/开启"
		}, {
			label: "服务状态",
			command: "/状态"
		}]
	}) });
};

export { res_default as default };