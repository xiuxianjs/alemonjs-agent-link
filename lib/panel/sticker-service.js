import { getMediaConfig } from "../media/config.js";
import { imageMime } from "../media/download.js";
import { collectSticker, editStickerAsset, listAssets, loadSticker, stickerRevision } from "../media/stickers.js";

// src/panel/sticker-service.ts
const stickerAssets = async () => {
	const config = getMediaConfig();
	return {
		capacity: config.stickerMaxItems,
		items: (await listAssets(config)).map((item) => {
			const { file: _file, ...publicItem } = item;
			return {
				...publicItem,
				revision: stickerRevision(item)
			};
		})
	};
};
const stickerImage = async (id) => {
	const config = getMediaConfig();
	const item = (await listAssets(config)).find((item) => item.id === id);
	if (!item) throw new Error("表情不存在");
	const data = await loadSticker(item, config);
	return {
		data,
		mime: imageMime(data)
	};
};
const saveStickerAsset = async (input, remove = false) => {
	const body = input;
	if (!body || typeof body.id !== "string" || typeof body.revision !== "string" || !remove && (typeof body.name !== "string" || !Array.isArray(body.tags))) throw new Error("表情设置无效");
	await editStickerAsset(getMediaConfig(), body.id, body.revision, remove ? null : {
		name: body.name,
		tags: body.tags
	});
};
const uploadStickerAsset = async (input) => {
	const body = input;
	if (!body || typeof body.data !== "string" || body.data.length > 7340032 || !body.data.length || body.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(body.data) || typeof body.name !== "string" || !body.name.trim() || !Array.isArray(body.tags) || !["sticker", "avatar"].includes(body.kind)) throw new Error("上传内容无效");
	const data = Buffer.from(body.data, "base64");
	if (data.length > 5242880) throw new Error("图片最多5MB");
	return await collectSticker(getMediaConfig(), data, body.tags, AbortSignal.timeout(15e3), {
		name: body.name.trim(),
		kind: body.kind,
		from: "manual"
	});
};

export { saveStickerAsset, stickerAssets, stickerImage, uploadStickerAsset };