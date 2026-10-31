import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getMoodStore, moodOptions } from "../../companion/mood.js";
import "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { commandExpression, commandMoodText } from "../../companion/command-expression.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-mood/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	const reply = (text, actions = [{
		label: "服务状态",
		command: "/状态"
	}, {
		label: "人格说明",
		command: "/人格 帮助"
	}]) => message.send({ format: commandBubble(text, "当前心情", {
		platform: event.Platform,
		actions
	}) });
	if (route.rawArgs.length) {
		await reply("心情仅供查看，不通过指令修改数值。请使用下方入口查看当前状态。", [{
			label: "查看心情",
			command: "/心情"
		}]);
		return;
	}
	try {
		const config = getDSHConfig();
		if (event.IsPrivate && !await canPrivateChatWithKey(event, config.privateChatAccess)) {
			await reply("当前未开放此私聊。可先查看个人 Key 与额度说明。", [{
				label: "额度说明",
				command: "/帮助 额度"
			}]);
			return;
		}
		const channelId = getConversationId(event);
		if (!channelId || !event.Platform) {
			await reply("无法识别当前会话，请重新发送。");
			return;
		}
		if (config.modules?.disabled?.includes("mood")) {
			await reply("心情功能目前没有开启。", [{
				label: "人格说明",
				command: "/人格 帮助"
			}]);
			return;
		}
		const store = getMoodStore(config);
		const scope = {
			platform: event.Platform,
			channelId
		};
		const snapshot = store.snapshot(scope, moodOptions(config), config.retentionDays);
		const sections = store.history(scope).slice(0, 5).map((row) => ({
			title: new Date(row.at).toLocaleString("zh-CN", {
				timeZone: "Asia/Shanghai",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false
			}),
			text: `变化 ${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)} · 当时心情 ${row.value.toFixed(1)}/100`
		}));
		const text = [commandExpression(config, scope, commandMoodText(snapshot.value), ""), `心情：${snapshot.label} ${snapshot.value.toFixed(1)}/100`].filter(Boolean).join("\n\n");
		assertMessageDelivered(await message.send({ format: sectionBubble("当前心情", `${event.IsPrivate ? "本人私聊" : "当前群聊"}\n${text}`, sections.length ? sections : [{
			title: "最近变化",
			text: "暂时没有心情变化记录。"
		}], {
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
	} catch {
		await reply("心情暂时无法读取，请稍后重试。", [{
			label: "重新查看",
			command: "/心情"
		}, {
			label: "服务状态",
			command: "/状态"
		}]);
	}
};

export { res_default as default };