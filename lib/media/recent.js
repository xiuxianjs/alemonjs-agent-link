import { getMediaConfig } from "./config.js";
import { downloadAttachment, imageMime } from "./download.js";
import { bindOnebotImageResolver } from "./onebot-images.js";

// src/media/recent.ts
const TTL = 18e5;
const MAX_BYTES = 5242880;
const store = /* @__PURE__ */ new Map();
const keyOf = (platform, channelId) => `${platform}:${channelId}`;
const conversationOf = (event) => event.IsPrivate ? event.Platform && event.UserId ? `private:${JSON.stringify([event.Platform, event.UserId])}` : "" : event.ChannelId || "";
/**
* Keep a small in-memory window of recent image attachments so "把刚才那张做成表情" works
* without quoting. Only metadata/URLs are retained; bytes are downloaded on demand.
*/
const rememberRecentMedia = (event) => {
	const platform = event.Platform || "";
	const channelId = conversationOf(event);
	if (event.IsBot || !platform || !channelId || !event.MessageId) return;
	const candidates = (event.MessageMedia || []).map((item, index) => ({
		item,
		index
	})).filter(({ item, index }) => [
		"image",
		"sticker",
		"animation"
	].includes(item.Type) && (Boolean(item.Url) || platform === "onebot" && index < 5 && Boolean(item._onebotImageFile)));
	if (!candidates.length) return;
	const now = Date.now();
	const key = keyOf(platform, channelId);
	const list = (store.get(key) || []).filter((entry) => now - entry.at < TTL);
	for (const { item, index } of candidates.slice(0, 3)) list.push({
		at: now,
		userId: event.UserId || "",
		item: { ...item },
		index,
		event: { ...event }
	});
	store.set(key, list.slice(-6));
	while (store.size > 500) {
		let removed = false;
		for (const candidate of store.keys()) {
			if (candidate === key) continue;
			store.delete(candidate);
			removed = true;
			break;
		}
		if (!removed) break;
	}
};
const clearRecentMedia = () => {
	store.clear();
};
/** Resolve the most recent image in a conversation, preferring the caller's own uploads. */
const takeRecentImage = async (platform, channelId, signal, userId, download = downloadAttachment) => {
	const now = Date.now();
	const entries = (store.get(keyOf(platform, channelId)) || []).filter((entry) => now - entry.at < TTL);
	if (!entries.length) return void 0;
	if (entries.length !== (store.get(keyOf(platform, channelId)) || []).length) store.set(keyOf(platform, channelId), entries);
	const entry = [...entries].reverse().find((item) => userId && item.userId === userId) || entries[entries.length - 1];
	if (!entry) return void 0;
	const config = getMediaConfig();
	const maxBytes = Math.min(config.maxBytes, MAX_BYTES);
	if (entry.item.Url) try {
		const data = await download(entry.item.Url, {
			...config,
			maxBytes
		}, signal);
		if (data.length <= maxBytes && imageMime(data)) return data;
	} catch {
		signal.throwIfAborted();
	}
	const lookup = bindOnebotImageResolver(entry.event);
	if (lookup) {
		const value = await lookup(entry.index);
		signal.throwIfAborted();
		if (value?.base64 && value.base64.length <= Math.ceil(maxBytes * 4 / 3) + 4) {
			const data = Buffer.from(value.base64, "base64");
			if (data.length <= maxBytes && imageMime(data)) return data;
		} else if (value?.url) {
			const data = await download(value.url, {
				...config,
				maxBytes
			}, signal);
			if (data.length <= maxBytes && imageMime(data)) return data;
		}
	}
};

export { clearRecentMedia, rememberRecentMedia, takeRecentImage };