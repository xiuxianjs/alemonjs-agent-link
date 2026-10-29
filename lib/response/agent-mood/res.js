import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMoodStore, moodOptions } from "../../companion/mood.js";
import "../../dsh/client.js";
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
	const [message] = useMessage();
	const table = history.length ? [
		"| 时间 | 变化 | 心情 |",
		"| --- | --- | --- |",
		...history.map((row) => {
			return `| ${new Date(row.at).toLocaleString("zh-CN", {
				timeZone: "Asia/Shanghai",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			})} | ${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)} | ${Math.round(row.value)} |`;
		})
	].join("\n") : "";
	const text = config.modules?.disabled?.includes("mood") ? "心情模块已停用。" : [`心情：${snapshot.label} ${Math.round(snapshot.value)}/100`, table].filter(Boolean).join("\n\n");
	assertMessageDelivered(await message.send({ format: commandBubble(text, "肥鱼的心情", {
		platform: event.Platform,
		layout: "inline",
		actions: [
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
		]
	}) }));
};

export { res_default as default };