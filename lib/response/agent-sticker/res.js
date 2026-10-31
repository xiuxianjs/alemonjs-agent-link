import { MediaError, getMediaConfig } from "../../media/config.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { ownerPrivatePolicy, publicPrivatePolicy } from "../../state/registry.js";
import { toUserMessage } from "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { runCoordinatedChat } from "../../dsh/orchestrator.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { chooseSticker, listStickers, loadSticker, markStickerUsed, setStickerEmoji, updateSticker } from "../../media/stickers.js";
import { sendOnebotSticker } from "../../media/onebot-sticker-send.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { addOnebotFavoriteSticker, deleteOnebotFavoriteSticker, fetchOnebotFavoriteStickers, renameOnebotFavoriteSticker } from "../../media/onebot-favorites.js";
import { importStickerUrls } from "../../media/sticker-import.js";
import { ResultCode, useEvent, useMedia, useMessage, useRoute } from "alemonjs";

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
			await reply("当前未开放此私聊。可发送 /帮助 额度 查看个人 Key 的使用方式。");
			return;
		}
		const query = route.rawArgs.join(" ").trim();
		if (query === "帮助") {
			await message.send({ format: sectionBubble("表情怎么用", "先选素材，再在对应条目旁操作。", [
				{
					title: "发送表情",
					text: "按名称或标签挑选，也可以在列表中点击发送。",
					actions: [{
						label: "查看素材",
						command: "/表情"
					}]
				},
				...event.IsMaster ? [{
					title: "删除素材",
					text: "列表中的删除入口会移除本地素材；OneBot 还会尝试删除对应 QQ 收藏。",
					actions: [{
						label: "选择素材",
						command: "/表情"
					}]
				}] : [],
				...event.IsMaster && event.Platform === "onebot" ? [{
					title: "导入 QQ 收藏",
					text: "把 QQ 收藏中的表情加入素材库，单次读取最多 50 张。",
					actions: [{
						label: "导入收藏",
						command: "/表情 导入"
					}]
				}, {
					title: "同步到 QQ 收藏",
					text: "把素材库中非导入的表情添加到 QQ 收藏或更新名称，单次最多 20 张。",
					actions: [{
						label: "同步收藏",
						command: "/表情 同步"
					}]
				}] : []
			], {
				platform: event.Platform,
				actions: [{
					label: "媒体帮助",
					command: "/帮助 媒体"
				}]
			}) });
			return;
		}
		const pageMatch = query.match(/^(?:列表|第)\s*(\d+)\s*(?:页)?$/u);
		const listing = !query || query === "列表" || Boolean(pageMatch);
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
					await reply("QQ 收藏里暂时没有能导入的表情。");
					return;
				}
				let imported;
				try {
					imported = await importStickerUrls(settings, urls, AbortSignal.any([signal, AbortSignal.timeout(12e4)]));
				} catch {
					signal.throwIfAborted();
					await reply("这次导入超时或中断了，已经导入的表情还在素材库里。");
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
					await reply("我没找到要删除的表情，先用 /表情 核对一下编号或名称吧。");
					return;
				}
				const removedFromQQ = target.emojiId && event.Platform === "onebot" ? await deleteOnebotFavoriteSticker(event, target.emojiId) : false;
				const removed = await updateSticker(settings, target.id, null, signal);
				await reply(removed ? `已从素材库移除${target.name ? `「${target.name}」` : ` ${target.id}`}${target.emojiId ? removedFromQQ ? "，并删除 QQ 收藏。" : "，但 QQ 收藏删除未确认。" : "。"}` : "未找到该表情编号。");
				return;
			}
			if (listing) {
				if (!items.length) await reply("表情库里还没有素材，添加后才能发出来。");
				else {
					const pageSize = 8;
					const pages = Math.max(1, Math.ceil(items.length / pageSize));
					const requestedPage = query === "列表" ? 1 : Number.parseInt(pageMatch?.[1] ?? "1", 10);
					const page = Number.isSafeInteger(requestedPage) ? Math.min(pages, Math.max(1, requestedPage)) : 1;
					const start = (page - 1) * pageSize;
					const sections = items.slice(start, start + pageSize).map((item) => ({
						title: `${item.id}${item.name ? `（${item.name}）` : ""}`,
						text: item.tags.length ? `标签：${item.tags.join("、").slice(0, 40)}` : "",
						actions: [{
							label: "发送",
							command: `/表情 ${item.id}`
						}, ...event.IsMaster ? [{
							label: "删除素材",
							command: `/表情 删除 ${item.id}`
						}] : []]
					}));
					const nav = [
						...page > 1 ? [{
							label: "上一页",
							command: `/表情 列表 ${page - 1}`
						}] : [],
						...page < pages ? [{
							label: "下一页",
							command: `/表情 列表 ${page + 1}`
						}] : [],
						...pages === 1 ? [{
							label: "刷新",
							command: "/表情"
						}] : [],
						{
							label: "帮助",
							command: "/表情 帮助"
						}
					];
					assertMessageDelivered(await message.send({ format: sectionBubble("表情素材", `共 ${items.length} 个 · 第 ${page}/${pages} 页；点击填入发送指令。`, sections, {
						platform: event.Platform,
						actions: nav
					}) }));
				}
				return;
			}
			const selected = chooseSticker(items, query);
			if (!selected) {
				await reply("我这里没找到这个表情，可以用 /表情 看看有哪些。");
				return;
			}
			const data = await loadSticker(selected, settings);
			signal.throwIfAborted();
			const onebotReceipt = await sendOnebotSticker(event, data, event.MessageId);
			assertMessageDelivered(onebotReceipt ? [{
				code: ResultCode.Ok,
				data: { messageId: onebotReceipt.messageId }
			}] : [await media.send({
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