import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMoodStore, moodOptions } from "../../companion/mood.js";
import "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-mood/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const config = getDSHConfig();
	if (event.IsPrivate && !await canPrivateChatWithKey(event, config.privateChatAccess)) return;
	const channelId = getConversationId(event);
	if (!channelId || !event.Platform) return;
	const store = getMoodStore(config);
	const scope = {
		platform: event.Platform,
		channelId
	};
	const snapshot = store.snapshot(scope, moodOptions(config), config.retentionDays);
	const history = store.history(scope).slice(0, 5);
	const text = config.modules?.disabled?.includes("mood") ? "心情模块已停用。" : [`心情：${snapshot.label} ${Math.round(snapshot.value)}/100`, ...history.map((row) => `${new Date(row.at).toLocaleString("zh-CN", {
		timeZone: "Asia/Shanghai",
		hour12: false
	})} ${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)} → ${Math.round(row.value)}`)].join("\n");
	const [message] = useMessage();
	const chars = Array.from(text);
	const chunks = [];
	for (let i = 0; i < chars.length; i += config.maxMessageLength) chunks.push(chars.slice(i, i + config.maxMessageLength).join(""));
	for (const [index, chunk] of chunks.entries()) assertMessageDelivered(await message.send({ format: commandBubble(chunk, "肥鱼的心情", {
		platform: event.Platform,
		actions: index === chunks.length - 1 ? [
			{
				label: "刷新心情",
				command: "/心情"
			},
			{
				label: "人格列表",
				command: "/人格"
			},
			{
				label: "人格帮助",
				command: "/人格 帮助"
			}
		] : []
	}) }));
};

export { res_default as default };