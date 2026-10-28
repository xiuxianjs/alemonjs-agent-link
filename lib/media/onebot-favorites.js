import { ResultCode, useClient } from "alemonjs";

// src/media/onebot-favorites.ts
const clientOf = (event) => {
	if (event.Platform !== "onebot") return void 0;
	try {
		return useClient(event)[0];
	} catch {
		return;
	}
};
const firstResult = async (run) => {
	try {
		const result = await run();
		return Array.isArray(result) && result.length === 1 && result[0].code === ResultCode.Ok ? result[0] : void 0;
	} catch {
		return;
	}
};
/** Read the bot account's QQ favorite stickers through the OneBot extension action, if available. */
const fetchOnebotFavoriteStickers = async (event, count) => {
	if (event.Platform !== "onebot" || !Number.isSafeInteger(count) || count < 1 || count > 500) return void 0;
	const client = clientOf(event);
	if (!client) return void 0;
	const result = await firstResult(() => client.agentLink.stickerFavorites({ count }));
	if (!result) return void 0;
	const urls = result.data?.urls;
	return Array.isArray(urls) ? urls.filter((url) => typeof url === "string" && url.length <= 2048 && /^https:\/\//u.test(url) && !/[\0\r\n]/u.test(url)) : [];
};
/** Add one local image to the bot account's QQ favorite stickers and return the platform emoji id. */
const addOnebotFavoriteSticker = async (event, data, name) => {
	if (event.Platform !== "onebot" || data.length === 0 || data.length > 5242880) return void 0;
	const normalized = typeof name === "string" ? name.trim().slice(0, 20) : "";
	const client = clientOf(event);
	if (!client) return void 0;
	const emojiId = (await firstResult(() => client.agentLink.stickerFavoriteAdd({
		data: data.toString("base64"),
		...normalized ? { name: normalized } : {}
	})))?.data?.emojiId;
	return typeof emojiId === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(emojiId) ? emojiId : void 0;
};
const renameOnebotFavoriteSticker = async (event, emojiId, name) => {
	const normalized = typeof name === "string" ? name.trim().slice(0, 20) : "";
	if (event.Platform !== "onebot" || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId) || !normalized) return false;
	const client = clientOf(event);
	return client ? Boolean(await firstResult(() => client.agentLink.stickerFavoriteRename({
		emojiId,
		name: normalized
	}))) : false;
};
const deleteOnebotFavoriteSticker = async (event, emojiId) => {
	if (event.Platform !== "onebot" || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId)) return false;
	const client = clientOf(event);
	return client ? Boolean(await firstResult(() => client.agentLink.stickerFavoriteDelete({ emojiId }))) : false;
};

export { addOnebotFavoriteSticker, deleteOnebotFavoriteSticker, fetchOnebotFavoriteStickers, renameOnebotFavoriteSticker };