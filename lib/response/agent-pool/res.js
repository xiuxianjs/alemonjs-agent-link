import { commandBubble, sectionBubble } from "../bubble.js";
import { poolAction, poolBalances, poolSnapshot } from "../../panel/pool-service.js";
import { readPoolSettings, updatePoolSettings } from "../../panel/pool-settings.js";
import { poolPageView } from "./format.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-pool/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const reply = (text) => message.send({ format: commandBubble(text, "额度轮转", {
		platform: event.Platform,
		actions: [{
			label: "刷新",
			command: "/额度轮转"
		}]
	}) });
	if (!event.IsMaster) {
		await reply("额度轮转仅限机器人主人查看。");
		return;
	}
	try {
		const args = route.rawArgs.map(String).map((value) => value.trim()).filter(Boolean);
		const action = args[0] || "";
		const settings = await readPoolSettings();
		if ([
			"启用",
			"停用",
			"测活",
			"通测",
			"测试",
			"查额度"
		].includes(action)) {
			const id = args.slice(1).join(" ");
			if (!id) {
				await reply("用法：/额度轮转 启用|停用|测活|通测|查额度 端点ID");
				return;
			}
			if (action === "启用" || action === "停用") {
				await updatePoolSettings({
					revision: settings.revision,
					action: "endpoint",
					id,
					values: { enabled: action === "启用" }
				});
				await reply(`${id} 已${action}并保存。`);
			} else if (action === "查额度") await reply(`${id}：${(await poolBalances(id))[id]?.text || "额度未知"}`);
			else {
				await poolAction(id, action === "通测" ? "health-check" : "probe");
				await reply(`${id} 已执行${action}，请刷新查看结果。`);
			}
			return;
		}
		const snapshot = await poolSnapshot();
		const balances = await poolBalances();
		const view = poolPageView(snapshot.endpoints, Number.parseInt(action || "1", 10), snapshot.sampledAt, new Map(Object.entries(balances)), snapshot.balanceAlertYuan, snapshot.bridge);
		const totals = snapshot.endpoints.reduce((sum, row) => ({
			total: sum.total + row.totalCalls,
			success: sum.success + row.successfulCalls,
			failed: sum.failed + row.failedCalls
		}), {
			total: 0,
			success: 0,
			failed: 0
		});
		const gate = snapshot.replyGateStatistics;
		const sections = [
			{
				title: "调用统计",
				text: `尝试 ${totals.total} · 成功 ${totals.success} · 失败 ${totals.failed} · 成功率 ${totals.success + totals.failed ? (totals.success / (totals.success + totals.failed) * 100).toFixed(1) + "%" : "—"}\n含门控及发送前拦截；重试单独计次。`
			},
			{
				title: "回复门控调用",
				text: `尝试 ${gate.total} · 成功 ${gate.success} · 失败 ${gate.failed}\n包含池内、独立配置与自带 Key；成功表示响应有效。`
			},
			...view.rows.map((row) => ({
				title: `${row.number}. ${row.id} · ${row.model}`,
				text: row.detail,
				actions: [
					{
						label: row.disabled ? "启用" : "停用",
						command: `/额度轮转 ${row.disabled ? "启用" : "停用"} ${row.id}`
					},
					{
						label: "测活",
						command: `/额度轮转 测活 ${row.id}`
					},
					{
						label: "查额度",
						command: `/额度轮转 查额度 ${row.id}`
					}
				]
			})),
			{
				title: "轮转规则",
				text: `轮转${snapshot.enabled ? "已启用" : "未启用"} · 策略 ${settings.modelPool.strategy || "balanced"}\n最大尝试 ${settings.modelPool.maxAttempts ?? 3} 次`
			},
			{
				title: "本地额度保护",
				text: `额度保护${snapshot.budget.enabled ? "已启用" : "未启用"}\n全局每日限额 ${snapshot.budget.globalDailyYuan || "不限"} · 个人每日限额 ${snapshot.budget.personalDailyYuan ?? 1} 元\n以上是配置限额，不是剩余额度。`
			},
			{
				title: `第 ${view.page}/${view.pages} 页`,
				text: `共 ${view.total} 个端点；新增、编辑及规则配置请使用前端额度轮转页面。`,
				actions: [
					...view.page > 1 ? [{
						label: "上一页",
						command: `/额度轮转 ${view.page - 1}`
					}] : [],
					...view.page < view.pages ? [{
						label: "下一页",
						command: `/额度轮转 ${view.page + 1}`
					}] : [],
					{
						label: "刷新",
						command: "/额度轮转"
					}
				]
			}
		];
		await message.send({ format: sectionBubble("额度轮转", "累计统计按端点 ID 保存；端点额度分别显示，不跨账号汇总。", sections, {
			platform: event.Platform,
			layout: "inline"
		}) });
	} catch {
		await reply("读取或操作失败，请检查端点配置及服务状态后重试。");
	}
};

export { res_default as default };