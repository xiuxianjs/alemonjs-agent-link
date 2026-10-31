import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getDSHCredentials } from "../../dsh/credentials.js";
import "../../dsh/client.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { listAvailableModels } from "../../dsh/models.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-models/res.ts
var res_default = async () => {
	const [eventContext] = useEvent({ selects: "private.message.create" });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	const [route] = useRoute();
	if (!event.IsMaster) {
		await message.send({ format: commandBubble("公共模型列表仅限机器人主人查看。个人钥匙和权益可从下方入口查看。", "模型列表", {
			platform: event.Platform,
			actions: [{
				label: "我的钥匙",
				command: "/我的钥匙 私聊"
			}, {
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	const args = route.rawArgs.map(String).join(" ").trim();
	if (args && (!/^[1-9]\d*$/u.test(args) || !Number.isSafeInteger(Number(args)))) {
		await message.send({ format: commandBubble("没有识别出页码。请返回模型列表，再使用翻页入口。", "模型列表", {
			platform: event.Platform,
			actions: [{
				label: "模型列表",
				command: "/模型列表"
			}]
		}) });
		return;
	}
	try {
		const credentials = await getDSHCredentials();
		if (!credentials) {
			await message.send({ format: commandBubble("尚未配置模型密钥，请查看 /密钥配置。", "模型列表", {
				platform: event.Platform,
				actions: [
					{
						label: "当前模型",
						command: "/当前模型"
					},
					{
						label: "密钥配置",
						command: "/密钥配置"
					},
					{
						label: "模型列表",
						command: "/模型列表"
					}
				]
			}) });
			return;
		}
		const config = getDSHConfig();
		const models = await listAvailableModels(credentials);
		const current = credentials.model || config.model;
		const pageSize = 8;
		const pages = Math.max(1, Math.ceil(models.length / pageSize));
		const requested = Number(args || "1");
		const page = Number.isSafeInteger(requested) ? Math.min(pages, Math.max(1, requested)) : 1;
		const start = (page - 1) * pageSize;
		const sections = models.slice(start, start + pageSize).map((model, index) => ({
			title: `${start + index + 1}. ${model}`,
			text: model === current ? "当前使用" : "可用模型"
		}));
		const nav = [
			...page > 1 ? [{
				label: "上一页",
				command: `/模型列表 ${page - 1}`
			}] : [],
			...page < pages ? [{
				label: "下一页",
				command: `/模型列表 ${page + 1}`
			}] : [],
			{
				label: "刷新",
				command: `/模型列表 ${page}`
			},
			{
				label: "当前模型",
				command: "/当前模型"
			}
		];
		const intro = models.length ? `当前模型：${current}；共 ${models.length} 个。` : `当前配置：${current}。服务未返回可列出的模型，不代表当前模型不可用。`;
		await message.send({ format: sectionBubble("模型列表", `${intro} 第 ${page}/${pages} 页`, sections, {
			platform: event.Platform,
			layout: "inline",
			actions: nav
		}) });
	} catch {
		await message.send({ format: commandBubble("模型列表读取失败，请检查密钥和服务地址。", "模型列表", {
			platform: event.Platform,
			actions: [{
				label: "密钥配置",
				command: "/密钥配置"
			}, {
				label: "重试",
				command: "/模型列表"
			}]
		}) });
	}
};

export { res_default as default };