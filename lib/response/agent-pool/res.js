import { getDSHConfig } from "../../dsh/runtime-config.js";
import { fetchPoolBalances } from "../../model-pool/balance.js";
import { getCredentialPool } from "../../credentials/pool.js";
import "../../dsh/client.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { readBridgeMetrics } from "../../model-pool/bridge-metrics.js";
import { poolPageView } from "./format.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-pool/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	const [message] = useMessage();
	if (!event.IsMaster) {
		await message.send({ format: commandBubble("模型池状态仅限机器人主人查看。", "模型池", { platform: event.Platform }) });
		return;
	}
	let pool;
	try {
		pool = getCredentialPool(getDSHConfig());
	} catch {
		await message.send({ format: commandBubble("模型池配置无效，请检查 modelPool。", "模型池", { platform: event.Platform }) });
		return;
	}
	if (!pool) {
		await message.send({ format: commandBubble("未配置 modelPool，当前使用单 Key。\n配置多 Key 后可在这里查看轮转状态和补货提示。", "模型池", {
			platform: event.Platform,
			actions: [{
				label: "当前模型",
				command: "/当前模型"
			}, {
				label: "密钥配置",
				command: "/密钥配置"
			}]
		}) });
		return;
	}
	const args = route.rawArgs.map(String).map((value) => value.trim()).filter(Boolean);
	const action = args[0] ?? "";
	if ([
		"启用",
		"停用",
		"测活",
		"测试",
		"通测"
	].includes(action)) {
		const id = args.slice(1).join(" ").trim();
		if (!id) {
			await message.send({ format: commandBubble("用法：/模型池 启用|停用|测活|通测 端点ID", "模型池", {
				platform: event.Platform,
				actions: [{
					label: "返回模型池",
					command: "/模型池"
				}]
			}) });
			return;
		}
		let ok = false;
		try {
			ok = action === "启用" ? pool.setEndpointEnabled(id, true) : action === "停用" ? pool.setEndpointEnabled(id, false) : await pool.probeEndpoint(id, action === "通测");
		} catch {
			ok = false;
		}
		await message.send({ format: commandBubble(ok ? action === "启用" ? `${id} 已启用（本次运行）；重启后按配置恢复。` : action === "停用" ? `${id} 已停用（本次运行）；重启后按配置恢复。` : `${id} 已执行${action === "通测" ? "通测" : "测活"}，结果见 /模型池。` : `没有找到端点 ${id}。`, "模型池", {
			platform: event.Platform,
			actions: [{
				label: "返回模型池",
				command: "/模型池"
			}]
		}) });
		return;
	}
	const requested = Number.parseInt(String(args[0] ?? "1"), 10);
	const [balances, bridge] = await Promise.all([fetchPoolBalances(pool.config), readBridgeMetrics(getDSHConfig())]);
	const view = poolPageView(pool.status, Number.isFinite(requested) ? requested : 1, Date.now(), balances, pool.config.balanceAlertYuan, bridge);
	const sections = view.rows.map((row) => ({
		title: `${row.number}. ${row.id} · ${row.provider} · ${row.model}`,
		text: row.detail,
		actions: [{
			label: row.disabled ? "启用" : "停用",
			command: `/模型池 ${row.disabled ? "启用" : "停用"} ${row.id}`
		}, {
			label: "通测",
			command: `/模型池 通测 ${row.id}`
		}]
	}));
	const nav = [
		...view.page > 1 ? [{
			label: "上一页",
			command: `/模型池 ${view.page - 1}`
		}] : [],
		...view.page < view.pages ? [{
			label: "下一页",
			command: `/模型池 ${view.page + 1}`
		}] : [],
		{
			label: "刷新",
			command: "/模型池"
		}
	];
	sections.push({
		title: `第 ${view.page}/${view.pages} 页`,
		text: `共 ${view.total} 个端点；可用 ${view.available}。`,
		actions: nav
	});
	await message.send({ format: sectionBubble("模型池", view.total === 0 ? "没有端点。" : view.needsRefill ? "建议补货。启停只影响本次运行。" : "启停只影响本次运行。", sections, {
		platform: event.Platform,
		layout: "inline"
	}) });
};

export { res_default as default };