import { getDSHConfig } from "../../dsh/runtime-config.js";
import { groupPolicy } from "../../social/group-settings.js";
import { SessionRegistry } from "../../state/registry.js";
import "../../dsh/client.js";
import { isKeyEntitledGroup } from "../../social/groups.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-policy/res.ts
/** 权益是否真的作用在工具上：绑了 Key 且主人没有关闭 boundKeyTools。 */
const toolsEntitled = async (platform, channelId) => {
	if (!channelId) return false;
	return await isKeyEntitledGroup({
		platform,
		channelId
	}) && groupPolicy(getDSHConfig(), channelId, platform).boundKeyTools !== false;
};
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	if (event.IsPrivate) {
		await message.send({ format: commandBubble("请到需要管理的目标群里使用 /工具策略。", "本群工具权限", {
			platform: event.Platform,
			actions: [{
				label: "我的权限",
				command: "/我的权限"
			}]
		}) });
		return;
	}
	if (!event.ChannelId || !event.IsMaster) {
		await message.send({ format: commandBubble("本群工具策略由机器人主人管理。可以查看自己的权限，或进入群设置。", "本群工具权限", {
			platform: event.Platform,
			actions: [{
				label: "我的权限",
				command: "/我的权限"
			}, {
				label: "群设置",
				command: "/群设置"
			}]
		}) });
		return;
	}
	try {
		const registry = new SessionRegistry(getDSHConfig());
		const capabilityNames = {
			chat: "聊天",
			web: "网页",
			files: "文件",
			terminal: "终端"
		};
		const aliases = {
			状态: "status",
			聊天: "chat",
			网页: "web",
			文件: "files",
			终端: "terminal"
		};
		const rawRequested = String(route.rawArgs[0] || "status").toLowerCase();
		const requested = aliases[rawRequested] || rawRequested;
		if (requested === "status" && route.rawArgs.length <= 1) {
			const stored = await registry.policy(event.ChannelId);
			const entitled = await toolsEntitled(event.Platform, event.ChannelId);
			const policy = entitled ? {
				...stored,
				web: true,
				files: true
			} : stored;
			const toggle = (name, enabled) => [{
				label: enabled ? "关闭" : "开启",
				command: `/工具策略 ${name} ${enabled ? "关闭" : "开启"}`
			}];
			await message.send({ format: sectionBubble("本群工具权限", "切换会开始新话题；终端始终禁止。", [
				{
					title: "聊天",
					text: policy.chat ? "已开启" : "已关闭",
					actions: toggle("聊天", policy.chat)
				},
				{
					title: "网页",
					text: entitled ? "已开放（本群自带 Key）" : policy.web ? "已开启" : "已关闭",
					actions: entitled ? [] : toggle("网页", policy.web)
				},
				{
					title: "文件",
					text: entitled ? "已开放（本群自带 Key）" : policy.files ? "已开启" : "已关闭",
					actions: entitled ? [] : toggle("文件", policy.files)
				},
				{
					title: "终端",
					text: "禁止；文件操作仅限本群隔离目录。",
					actions: []
				}
			], {
				platform: event.Platform,
				actions: [{
					label: "刷新",
					command: "/工具策略 状态"
				}, {
					label: "群设置",
					command: "/群设置"
				}]
			}) });
			return;
		}
		const rawEnabled = String(route.rawArgs[1] || "").toLowerCase();
		const enabled = rawEnabled === "开启" ? "on" : rawEnabled === "关闭" ? "off" : rawEnabled;
		if (route.rawArgs.length !== 2 || ![
			"chat",
			"web",
			"files",
			"terminal"
		].includes(requested) || !["on", "off"].includes(enabled)) {
			await message.send({ format: commandBubble("没有识别出要修改的权限。请打开本群工具状态，在对应项目下选择开启或关闭。", "本群工具权限", {
				platform: event.Platform,
				actions: [{
					label: "查看本群工具",
					command: "/工具策略 状态"
				}]
			}) });
			return;
		}
		if (requested === "terminal") {
			await message.send({ format: commandBubble("终端禁止。文件操作仅限本群隔离目录。", "本群工具权限", {
				platform: event.Platform,
				actions: [{
					label: "查看状态",
					command: "/工具策略 状态"
				}]
			}) });
			return;
		}
		const policy = await registry.policy(event.ChannelId);
		if (enabled === "off" && (requested === "web" || requested === "files")) {
			if (await toolsEntitled(event.Platform, event.ChannelId)) {
				await message.send({ format: commandBubble("本群使用自带 Key，网页与文件已自动开放，无法在群内关闭。\n需要取消自动开放，请在本群配置中设置 boundKeyTools: false，再关闭对应工具权限。", "本群工具权限", {
					platform: event.Platform,
					actions: [{
						label: "查看状态",
						command: "/工具策略 状态"
					}]
				}) });
				return;
			}
		}
		await registry.setPolicy(event.ChannelId, {
			...policy,
			[requested]: enabled === "on"
		});
		await resetGroupSession(event.ChannelId, getDSHConfig());
		await message.send({ format: commandBubble(`本群${capabilityNames[requested]}已${enabled === "on" ? "开启" : "关闭"}，已开始新话题。`, "本群工具权限", {
			platform: event.Platform,
			actions: [{
				label: "核对当前权限",
				command: "/工具策略 状态"
			}]
		}) });
	} catch {
		await message.send({ format: commandBubble("本次操作未能确认完成。若刚才修改过权限，请先查看当前状态，再决定是否重试。", "本群工具权限", {
			platform: event.Platform,
			actions: [{
				label: "查看当前状态",
				command: "/工具策略 状态"
			}]
		}) });
	}
};

export { res_default as default };