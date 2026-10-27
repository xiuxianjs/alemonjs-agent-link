import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMoodStore, moodOptions } from "../../companion/mood.js";
import "../../dsh/client.js";
import { canPrivateChat, getConversationId } from "../dsh/util.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-mood/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) return;
	const event = context.current;
	const config = getDSHConfig();
	if (event.IsPrivate && !canPrivateChat(event, config.privateChatAccess)) return;
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
	for (let i = 0; i < chars.length; i += config.maxMessageLength) assertMessageDelivered(await message.send({ format: Format.create().addText(chars.slice(i, i + config.maxMessageLength).join("")) }));
};

export { res_default as default };