import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { getModuleRuntime } from "../../agent/modules.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-modules/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["private.message.create", "message.create"] });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	if (!event.IsPrivate || !event.IsMaster) {
		await message.send({ format: commandBubble("模块管理仅限机器人主人私聊使用。其他成员可以查看服务状态。", "模块状态", {
			platform: event.Platform,
			actions: [{
				label: "服务状态",
				command: "/状态"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	const args = route.rawArgs.map(String).join(" ").trim();
	if (args && !/^[1-9]\d*$/u.test(args)) {
		await message.send({ format: commandBubble("没有识别出页码。请返回模块列表，再使用翻页入口。", "模块状态", {
			platform: event.Platform,
			actions: [{
				label: "模块列表",
				command: "/模块状态"
			}]
		}) });
		return;
	}
	let text;
	try {
		const runtime = await getModuleRuntime(getDSHConfig());
		await runtime.refresh();
		const status = runtime.status();
		const pages = Math.max(1, Math.ceil(status.length / 6));
		const page = Math.min(pages, Math.max(1, Number(route.rawArgs[0]) || 1));
		const rows = status.slice((page - 1) * 6, page * 6).map((item) => {
			const state = item.state === "ready" ? "已加载" : item.state === "disabled" ? "已停用" : "加载失败";
			const detail = item.error ? `：${item.error.replace(/\|/gu, "/").slice(0, 40)}` : "";
			const version = item.state === "ready" && item.version ? item.version : "-";
			return {
				title: item.id,
				text: `${state}${detail} · 版本 ${version}`
			};
		});
		await message.send({ format: sectionBubble("模块状态", `共 ${status.length} 项 · 第 ${page}/${pages} 页`, rows, {
			platform: event.Platform,
			actions: [
				...page > 1 ? [{
					label: "上一页",
					command: `/模块状态 ${page - 1}`
				}] : [],
				...page < pages ? [{
					label: "下一页",
					command: `/模块状态 ${page + 1}`
				}] : [],
				{
					label: "刷新",
					command: `/模块状态 ${page}`
				},
				{
					label: "服务状态",
					command: "/状态"
				}
			]
		}) });
		return;
	} catch {
		text = "模块配置或目录不可用，请检查服务端配置和文件权限。";
	}
	await message.send({ format: commandBubble(text, "功能状态", {
		platform: event.Platform,
		layout: "inline",
		actions: [
			{
				label: "刷新状态",
				command: "/模块状态"
			},
			{
				label: "服务状态",
				command: "/状态"
			},
			{
				label: "帮助",
				command: "/帮助"
			}
		]
	}) });
};

export { res_default as default };