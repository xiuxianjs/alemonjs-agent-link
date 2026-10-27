import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SessionRegistry, ownerPrivatePolicy, publicPrivatePolicy } from "../../state/registry.js";
import { toUserMessage } from "../../dsh/client.js";
import { canPrivateChat, getConversationId } from "../dsh/util.js";
import { MediaError, getMediaConfig } from "../../media/config.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { runCoordinatedChat } from "../../dsh/orchestrator.js";
import { chooseSticker, listStickers, loadSticker } from "../../media/stickers.js";
import { Format, useEvent, useMedia, useMessage, useRoute } from "alemonjs";

// src/response/agent-sticker/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	const [media] = useMedia();
	if (!context.match.selects || !route.matched || context.current.IsBot) return;
	const event = context.current;
	const reply = async (text) => {
		assertMessageDelivered(await message.send({ format: Format.create().addText(text) }));
	};
	try {
		const config = getDSHConfig();
		const channelId = getConversationId(event);
		if (!channelId) {
			await reply("无法识别当前会话。");
			return;
		}
		if (event.IsPrivate && !canPrivateChat(event, config.privateChatAccess)) {
			await reply("仅机器人主人可在私聊中使用 Agent。");
			return;
		}
		const query = route.rawArgs.join(" ").trim();
		const result = await runCoordinatedChat({
			...event,
			ChannelId: channelId
		}, "", () => Promise.resolve(), void 0, void 0, event.IsPrivate ? event.IsMaster ? ownerPrivatePolicy : publicPrivatePolicy : void 0, void 0, { execute: async (signal) => {
			const settings = getMediaConfig();
			const items = await listStickers(settings);
			if (!query) {
				await reply(items.length ? `用法：/表情 编号或标签\n${items.map((item) => `${item.id}：${item.tags.join("、")}`).join("\n")}`.slice(0, config.maxMessageLength) : "表情库为空，请添加素材。");
				return;
			}
			const selected = chooseSticker(items, query);
			if (!selected) {
				await reply("未找到表情，/表情 查看清单。");
				return;
			}
			const data = await loadSticker(selected, settings);
			signal.throwIfAborted();
			if (!await new SessionRegistry(config).claimSticker(channelId, settings.stickerCooldownSeconds)) {
				await reply("表情冷却中，请稍后再发。");
				return;
			}
			signal.throwIfAborted();
			assertMessageDelivered([await media.send({
				type: "image",
				data: data.toString("base64"),
				name: selected.file.split(/[\\/]/u).at(-1),
				replyId: event.MessageId
			})]);
		} });
		if (!result.duplicate) await result.confirmDelivery();
	} catch (error) {
		await reply(error instanceof MediaError ? error.message : toUserMessage(error));
	}
};

export { res_default as default };