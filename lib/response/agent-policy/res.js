import { getGroupChatPolicy } from "../../social/group-policy.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SessionRegistry } from "../../state/registry.js";
import "../../dsh/client.js";
import { isKeyEntitledGroup } from "../../social/groups.js";
import { resetGroupSession } from "../../dsh/orchestrator.js";
import { commandBubble } from "../bubble.js";
import { useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-policy/res.ts
/** 权益是否真的作用在工具上：绑了 Key 且主人没有关闭 boundKeyTools。 */
const toolsEntitled = async (platform, channelId) => {
	if (!channelId) return false;
	return await isKeyEntitledGroup({
		platform,
		channelId
	}) && getGroupChatPolicy(getDSHConfig().groupChat, channelId).boundKeyTools !== false;
};
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	if (!eventContext.match.selects || !route.matched) return;
	const event = eventContext.current;
	if (event.IsPrivate) {
		await message.send({ format: commandBubble("请到需要管理的目标群里使用 /工具策略。", "本群工具权限") });
		return;
	}
	if (!event.ChannelId || !event.IsMaster) {
		await message.send({ format: commandBubble("只有机器人主人可在群内管理 Agent 策略。", "本群工具权限") });
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
		if (requested === "status") {
			const stored = await registry.policy(event.ChannelId);
			const entitled = await toolsEntitled(event.Platform, event.ChannelId);
			const policy = entitled ? {
				...stored,
				web: true,
				files: true
			} : stored;
			const note = entitled ? "\n本群自带 Key：网页与文件已自动开放（终端仍禁止）。" : "";
			await message.send({ format: commandBubble(`本群权限：聊天${policy.chat ? "开" : "关"} · 网页${policy.web ? "开" : "关"} · 文件${policy.files ? "开" : "关"}\n终端禁止；/工具策略 能力 开启或关闭${note}`, "本群工具权限", {
				platform: event.Platform,
				actions: [
					{
						label: "刷新状态",
						command: "/工具策略 状态"
					},
					{
						label: "网页开启",
						command: "/工具策略 网页 开启"
					},
					{
						label: "网页关闭",
						command: "/工具策略 网页 关闭"
					},
					{
						label: "文件开启",
						command: "/工具策略 文件 开启"
					},
					{
						label: "文件关闭",
						command: "/工具策略 文件 关闭"
					}
				]
			}) });
			return;
		}
		const rawEnabled = String(route.rawArgs[1] || "").toLowerCase();
		const enabled = rawEnabled === "开启" ? "on" : rawEnabled === "关闭" ? "off" : rawEnabled;
		if (![
			"chat",
			"web",
			"files",
			"terminal"
		].includes(requested) || !["on", "off"].includes(enabled)) {
			await message.send({ format: commandBubble("用法：/工具策略 状态，或 /工具策略 聊天|网页|文件 开启|关闭", "本群工具权限", {
				platform: event.Platform,
				actions: [
					{
						label: "查看状态",
						command: "/工具策略 状态"
					},
					{
						label: "网页开启",
						command: "/工具策略 网页 开启"
					},
					{
						label: "文件开启",
						command: "/工具策略 文件 开启"
					}
				]
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
				await message.send({ format: commandBubble("本群使用自带 Key，网页与文件已自动开放，无法在群内关闭。\n需要关闭请让主人在 groupChat.overrides 里为本群设置 boundKeyElevation: false。", "本群工具权限", {
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
		await message.send({ format: commandBubble(`本群${capabilityNames[requested]}已${enabled === "on" ? "开启" : "关闭"}，已开始新话题。`, "本群工具权限") });
	} catch {
		await message.send({ format: commandBubble("策略暂时无法读取，请稍后再试。", "本群工具权限") });
	}
};

export { res_default as default };