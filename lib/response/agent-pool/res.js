import { commandBubble, sectionBubble } from "../bubble.js";
import { poolAction, poolBalances, poolSnapshot } from "../../panel/pool-service.js";
import { readPoolSettings, updatePoolSettings } from "../../panel/pool-settings.js";
import { POOL_PAGE_SIZE, poolPageView } from "./format.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-pool/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	let returnPage = 1;
	const reply = (text) => message.send({ format: commandBubble(text, "额度轮转", {
		platform: event.Platform,
		actions: event.IsMaster ? [{
			label: "核对当前页",
			command: `/额度轮转 ${returnPage}`
		}, {
			label: "服务状态",
			command: "/状态"
		}] : [{
			label: "我的权限",
			command: "/我的权限"
		}, {
			label: "服务状态",
			command: "/状态"
		}]
	}) });
	if (!event.IsMaster) {
		await reply("额度轮转仅限机器人主人查看。");
		return;
	}
	try {
		const args = route.rawArgs.map(String).map((value) => value.trim()).filter(Boolean);
		const action = args[0] || "";
		if (![
			"启用",
			"停用",
			"测活",
			"通测",
			"测试",
			"查额度"
		].includes(action) && (args.length > 1 || action && (!/^[1-9]\d*$/u.test(action) || !Number.isSafeInteger(Number(action))))) {
			await reply("没有识别出页码或端点操作。请返回额度轮转列表，在对应端点下选择操作。");
			return;
		}
		returnPage = Number(action) || 1;
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
				await reply("还没有选择端点。打开额度轮转，在对应端点下点击要执行的操作。");
				return;
			}
			const endpointIndex = (settings.modelPool.endpoints || []).findIndex((endpoint) => endpoint.id === id);
			if (endpointIndex < 0) {
				await reply("这个端点已不存在或编号不完整。请重新打开列表选择端点。");
				return;
			}
			returnPage = Math.floor(endpointIndex / 5) + 1;
			if (action === "启用" || action === "停用") await reply(`${id} 的${action}设置${(await updatePoolSettings({
				revision: settings.revision,
				action: "endpoint",
				id,
				values: { enabled: action === "启用" }
			})).message}。请核对当前运行状态。`);
			else if (action === "查额度") await reply(`${id}：${(await poolBalances(id))[id]?.text || "额度未知"}`);
			else {
				await poolAction(id, action === "通测" ? "health-check" : "probe");
				await reply(`${id} 已执行${action}。是否可用请查看该端点的最新状态，本提示不代表检测通过。`);
			}
			return;
		}
		const snapshot = await poolSnapshot();
		const balances = await poolBalances();
		const view = poolPageView(snapshot.endpoints, Number(action || "1"), snapshot.sampledAt, new Map(Object.entries(balances)), snapshot.balanceAlertYuan, snapshot.bridge);
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
			}
		];
		await message.send({ format: sectionBubble("额度轮转", `共 ${view.total} 个端点 · 第 ${view.page}/${view.pages} 页。累计按端点 ID 保存，额度不跨账号汇总；新增和编辑在网页操作。`, sections, {
			platform: event.Platform,
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
					command: `/额度轮转 ${view.page}`
				},
				{
					label: "用量",
					command: "/用量"
				}
			]
		}) });
	} catch {
		await reply("读取或操作结果暂时无法确认。若刚才执行过端点启停，请先核对当前页状态，再决定是否重试。");
	}
};

export { res_default as default };