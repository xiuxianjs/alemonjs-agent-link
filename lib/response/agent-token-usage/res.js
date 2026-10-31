import { getDSHConfig } from "../../dsh/runtime-config.js";
import { readTokenUsage, usageDay } from "../../billing/token-usage.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { dirname } from "node:path";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-token-usage/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const reply = (text, actions = []) => message.send({ format: commandBubble(text, "Token 用量", {
		platform: event.Platform,
		actions
	}) });
	if (!event.IsMaster || !event.IsPrivate) {
		await reply("全局用量仅机器人主人私聊可查。当前账本按 Key 汇总，暂不提供个人或群用量查询。", [{
			label: "我的额度",
			command: "/额度"
		}, {
			label: "我的权限",
			command: "/我的权限"
		}]);
		return;
	}
	const args = route.rawArgs.map(String);
	const periods = [
		"今日",
		"本月",
		"本年",
		"累计"
	].map((label) => ({
		label,
		command: `/用量 ${label}`
	}));
	const help = () => message.send({ format: sectionBubble("怎样查看用量", "范围：全局，仅主人私聊可查；按北京时间统计。", [
		{
			title: "选择时间范围",
			text: "默认显示今日。通过下方入口选择时间范围。",
			actions: periods
		},
		{
			title: "查询历史日期",
			text: "按天：/用量 2026-01-15\n按月：/用量 2026-01\n按年：/用量 2026\n日期格式：YYYY-MM-DD、YYYY-MM 或 YYYY。"
		},
		{
			title: "统计边界",
			text: "仅含启用账本后的调用。未返回用量的请求不计入 Token 合计；删除 Key 不删除全局累计。"
		}
	], { platform: event.Platform }) });
	if (args.length > 1 || args[0] === "帮助") {
		await help();
		return;
	}
	const day = usageDay();
	const period = (/* @__PURE__ */ new Map([
		["今日", day],
		["本月", day.slice(0, 7)],
		["本年", day.slice(0, 4)],
		["累计", "all"],
		["总计", "all"]
	])).get(args[0]) || args[0] || day;
	try {
		const total = readTokenUsage(dirname(getDSHConfig().dshHomeRoot), period).total;
		const input = Number(total.input), output = Number(total.output);
		await reply(`范围：全局 · ${period === "all" ? "累计" : period}（北京时间）\n${Number(total.requests) === 0 ? "这个时间范围暂无调用记录。\n" : ""}输入：${input} Token\n输出：${output} Token\n合计：${input + output} Token\n缓存命中：${total.cached} Token（已含在输入中）\n请求：${total.requests} 次；用量已返回 ${total.known} 次、未知 ${Number(total.requests) - Number(total.known)} 次。\n仅统计启用账本后记录的调用；未知用量未计入 Token 合计。删除 Key 不删除全局累计。`, [...periods, {
			label: "历史查询说明",
			command: "/用量 帮助"
		}]);
	} catch {
		await reply("查询失败，可能是日期无效或账本暂不可用。请先尝试今日用量；需要历史日期时可查看查询说明。", [...periods, {
			label: "查询说明",
			command: "/用量 帮助"
		}]);
	}
};

export { res_default as default };