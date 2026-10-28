import { getDSHConfig } from "../../dsh/runtime-config.js";
import { SessionRegistry, ownerPrivatePolicy, publicPrivatePolicy } from "../../state/registry.js";
import { toUserMessage } from "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { MediaError, getMediaConfig } from "../../media/config.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { runCoordinatedChat } from "../../dsh/orchestrator.js";
import { chooseSticker, listStickers, loadSticker, markStickerUsed, setStickerEmoji, updateSticker } from "../../media/stickers.js";
import { commandBubble } from "../bubble.js";
import { addOnebotFavoriteSticker, deleteOnebotFavoriteSticker, fetchOnebotFavoriteStickers, renameOnebotFavoriteSticker } from "../../media/onebot-favorites.js";
import { importStickerUrls } from "../../media/sticker-import.js";
import { useEvent, useMedia, useMessage, useRoute } from "alemonjs";

// src/response/agent-sticker/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	const [message] = useMessage();
	const [media] = useMedia();
	if (!context.match.selects || !route.matched || context.current.IsBot) return;
	const event = context.current;
	const reply = async (text) => {
		assertMessageDelivered(await message.send({ format: commandBubble(text, "表情素材", {
			platform: event.Platform,
			actions: [{
				label: "表情列表",
				command: "/表情"
			}, {
				label: "帮助",
				command: "/帮助 媒体"
			}]
		}) }));
	};
	try {
		const config = getDSHConfig();
		const channelId = getConversationId(event);
		if (!channelId) {
			await reply("无法识别当前会话。");
			return;
		}
		if (event.IsPrivate && !await canPrivateChatWithKey(event, config.privateChatAccess)) {
			await reply("仅机器人主人可在私聊中使用 Agent。");
			return;
		}
		const query = route.rawArgs.join(" ").trim();
		const result = await runCoordinatedChat({
			...event,
			ChannelId: channelId
		}, "", () => Promise.resolve(), void 0, void 0, event.IsPrivate ? event.IsMaster ? ownerPrivatePolicy : publicPrivatePolicy : void 0, void 0, { execute: async (signal) => {
			const settings = getMediaConfig();
			if (query === "导入" || query === "导入收藏") {
				if (!event.IsMaster) {
					await reply("仅主人可导入 QQ 收藏表情。");
					return;
				}
				if (event.Platform !== "onebot") {
					await reply("仅 OneBot 支持导入 QQ 收藏表情。");
					return;
				}
				if (!settings.stickerRoot) {
					await reply("尚未配置表情素材目录。");
					return;
				}
				const urls = await fetchOnebotFavoriteStickers(event, 50);
				if (!urls) {
					await reply("读取 QQ 收藏失败，网关可能不支持该接口。");
					return;
				}
				if (!urls.length) {
					await reply("QQ 收藏里没有可导入的表情。");
					return;
				}
				let imported;
				try {
					imported = await importStickerUrls(settings, urls, AbortSignal.any([signal, AbortSignal.timeout(12e4)]));
				} catch {
					signal.throwIfAborted();
					await reply("导入超时或中断，已成功的部分仍保留在素材库。");
					return;
				}
				await reply(`读取到 ${urls.length} 张，本次处理 ${imported.total} 张：新增 ${imported.added} 张，已有 ${imported.existing} 张${imported.failed ? `，${imported.failed} 张失败` : ""}。`);
				return;
			}
			const items = await listStickers(settings);
			const [action, ...rest] = query.split(/\s+/u);
			const selector = rest.join(" ").trim();
			if (action === "同步" || action === "同步收藏") {
				if (!event.IsMaster) {
					await reply("仅主人可同步 QQ 收藏表情。");
					return;
				}
				if (event.Platform !== "onebot") {
					await reply("仅 OneBot 支持同步 QQ 收藏表情。");
					return;
				}
				const targetItem = selector ? chooseSticker(items, selector) : void 0;
				if (selector && !targetItem) {
					await reply("未找到要同步的表情。");
					return;
				}
				const selected = selector ? [targetItem] : items.filter((item) => item.from !== "import").slice(0, 20);
				let added = 0;
				let renamed = 0;
				let failed = 0;
				for (const item of selected) {
					signal.throwIfAborted();
					const name = (item.name || item.tags[0] || "").trim().slice(0, 20);
					if (item.emojiId) {
						if (!name) continue;
						if (await renameOnebotFavoriteSticker(event, item.emojiId, name)) renamed++;
						else failed++;
						continue;
					}
					if (item.from === "import") continue;
					try {
						const emojiId = await addOnebotFavoriteSticker(event, await loadSticker(item, settings), name || void 0);
						if (!emojiId) {
							failed++;
							continue;
						}
						await setStickerEmoji(settings, item.id, emojiId, signal);
						added++;
					} catch {
						signal.throwIfAborted();
						failed++;
					}
				}
				await reply(`同步完成：新增收藏 ${added} 张，更新名称 ${renamed} 张${failed ? `，${failed} 张失败` : ""}。${selector ? "" : "单次最多处理 20 张。"}`);
				return;
			}
			if (action === "删除" || action === "移除") {
				if (!event.IsMaster) {
					await reply("仅主人可删除表情。");
					return;
				}
				const target = selector ? chooseSticker(items, selector) : void 0;
				if (!target) {
					await reply("未找到要删除的表情，先用 /表情 查看编号或名称。");
					return;
				}
				const removedFromQQ = target.emojiId && event.Platform === "onebot" ? await deleteOnebotFavoriteSticker(event, target.emojiId) : false;
				const removed = await updateSticker(settings, target.id, null, signal);
				await reply(removed ? `已从素材库移除${target.name ? `「${target.name}」` : ` ${target.id}`}${target.emojiId ? removedFromQQ ? "，并删除 QQ 收藏。" : "，但 QQ 收藏删除未确认。" : "。"}` : "未找到该表情编号。");
				return;
			}
			if (!query) {
				await reply(items.length ? `用法：/表情 编号、名称或标签\n${items.map((item) => `${item.id}${item.name ? `（${item.name}）` : ""}：${item.tags.join("、")}`).join("\n")}`.slice(0, config.maxMessageLength) : "表情库为空，请添加素材。");
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
			await markStickerUsed(settings, selected.id, signal).catch(() => void 0);
		} });
		if (!result.duplicate) await result.confirmDelivery();
	} catch (error) {
		await reply(error instanceof MediaError ? error.message : toUserMessage(error));
	}
};

export { res_default as default };