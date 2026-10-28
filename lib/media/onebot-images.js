import { getMediaConfig } from "./config.js";
import { ResultCode, useClient } from "alemonjs";

// src/media/onebot-images.ts
const bindOnebotImageResolver = (event) => {
	if (event.Platform !== "onebot" || !event.MessageId) return;
	try {
		const [client] = useClient(event);
		return async (index) => {
			try {
				const result = await client.agentLink.resolveCurrentImage({ index });
				const value = result?.length === 1 && result[0].code === ResultCode.Ok ? result[0].data : void 0;
				if (typeof value?.base64 === "string") return { base64: value.base64 };
				if (typeof value?.url === "string") return { url: value.url };
			} catch {}
		};
	} catch {
		return;
	}
};
const resolveCurrentImages = async (event) => {
	const media = event.MessageMedia;
	if (event.Platform !== "onebot" || !event.MessageId || !media?.length) return media;
	if (!media.some((item) => [
		"image",
		"sticker",
		"animation"
	].includes(item.Type) && !item._onebotQuoted && item._onebotImageFile)) return media;
	try {
		if (media.length > getMediaConfig().maxAttachments) return media;
		const lookup = bindOnebotImageResolver(event);
		if (!lookup) return media;
		return await Promise.all(media.map(async (item, index) => {
			const file = item._onebotImageFile;
			if (![
				"image",
				"sticker",
				"animation"
			].includes(item.Type) || !file || item._onebotQuoted) return item;
			const resolve = async () => {
				try {
					const value = await lookup(index);
					if (typeof value?.base64 === "string") return {
						...item,
						_onebotImage: value.base64
					};
					if (typeof value?.url === "string") return {
						...item,
						Url: value.url
					};
				} catch {}
				return item;
			};
			return item.Url ? {
				...item,
				_onebotImageFallback: resolve
			} : await resolve();
		}));
	} catch {
		return media;
	}
};

export { bindOnebotImageResolver, resolveCurrentImages };