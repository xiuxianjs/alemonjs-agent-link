// src/media/onebot-direct.ts
const EMOJI_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const normalizeUrls = (rows) => rows.map((row) => {
	if (typeof row === "string") return row;
	if (row && typeof row === "object" && "url" in row && typeof row.url === "string") return row.url;
	return "";
}).filter((url) => url.length > 0 && url.length <= 2048 && /^https:\/\//u.test(url) && !/[\0\r\n]/u.test(url));
const emojiIdOf = (result) => {
	if (typeof result === "string") return EMOJI_ID.test(result) ? result : void 0;
	if (!result || typeof result !== "object") return void 0;
	const row = result;
	const nested = row.data && typeof row.data === "object" ? row.data : void 0;
	const value = [
		row.emoji_id,
		row.emojiId,
		row.id,
		nested?.emoji_id,
		nested?.emojiId,
		nested?.id
	].find((item) => typeof item === "string" || typeof item === "number");
	return typeof value === "string" || typeof value === "number" ? EMOJI_ID.test(String(value)) ? String(value) : void 0 : void 0;
};
/** Panel-only helpers: they read the live OneBot connection without a chat event. */
const fetchFavoriteUrlsDirect = async (connection, count) => {
	if (!Number.isSafeInteger(count) || count < 1 || count > 500) return void 0;
	try {
		const result = await connection.call("fetch_custom_face", { count });
		const rows = Array.isArray(result) ? result : result && typeof result === "object" && "data" in result && Array.isArray(result.data) ? result.data : [];
		return normalizeUrls(rows);
	} catch {
		return;
	}
};
const addFavoriteDirect = async (connection, data, name) => {
	if (!data.length || data.length > 5242880) return void 0;
	try {
		const normalized = typeof name === "string" ? name.trim().slice(0, 20) : "";
		const result = await connection.call("add_custom_face", {
			file: `base64://${data.toString("base64")}`,
			...normalized ? { name: normalized } : {}
		});
		return emojiIdOf(result);
	} catch {
		return;
	}
};
const renameFavoriteDirect = async (connection, emojiId, name) => {
	const normalized = typeof name === "string" ? name.trim().slice(0, 20) : "";
	if (!EMOJI_ID.test(emojiId) || !normalized) return false;
	try {
		await connection.call("modify_custom_face", {
			emoji_id: emojiId,
			desc: normalized
		});
		return true;
	} catch {
		return false;
	}
};
const deleteFavoriteDirect = async (connection, emojiId) => {
	if (!EMOJI_ID.test(emojiId)) return false;
	try {
		await connection.call("delete_custom_face", { emoji_id: emojiId });
		return true;
	} catch {
		return false;
	}
};

export { addFavoriteDirect, deleteFavoriteDirect, fetchFavoriteUrlsDirect, renameFavoriteDirect };