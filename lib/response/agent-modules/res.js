import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { commandBubble } from "../bubble.js";
import { getModuleRuntime } from "../../agent/modules.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/agent-modules/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: "private.message.create" });
	if (!context.match.selects || !context.current.IsMaster) return;
	const event = context.current;
	const [message] = useMessage();
	let text;
	try {
		const runtime = await getModuleRuntime(getDSHConfig());
		await runtime.refresh();
		text = [
			"| 模块 | 状态 | 版本 |",
			"| --- | --- | --- |",
			...runtime.status().map((item) => {
				const state = item.state === "ready" ? "已加载" : item.state === "disabled" ? "已停用" : "加载失败";
				const detail = item.error ? `：${item.error.replace(/\|/gu, "/").slice(0, 40)}` : "";
				const version = item.state === "ready" && item.version ? item.version : "-";
				return `| ${item.id} | ${state}${detail} | ${version} |`;
			})
		].join("\n");
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