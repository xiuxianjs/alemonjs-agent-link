import { commandBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-unbind/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: commandBubble("公共密钥仅限机器人主人移除。", "移除密钥") });
		return;
	}
	await message.send({ format: commandBubble("删除配置中的 alemonjs-agent-link.apiKey 并保存即可。", "移除密钥") });
};

export { res_default as default };