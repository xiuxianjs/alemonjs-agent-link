import { MediaError } from "./config.js";
import { downloadAttachment, imageMime } from "./download.js";
import { collectSticker } from "./stickers.js";
import { visionSource } from "./vision.js";
import { assessSticker } from "./providers.js";

// src/media/sticker-import.ts
const MAX_IMPORT = 30;
const MAX_IMPORT_BYTES = 5242880;
/**
* Import already-curated QQ favorite image URLs. This only reads from the platform; it never writes
* back to the user's QQ favorites. Every image still passes the normal format and manifest checks.
*/
const importStickerUrls = async (config, urls, signal, download = downloadAttachment, assess = assessSticker) => {
	if (!config.stickerRoot) throw new MediaError("尚未配置表情素材目录。");
	const selected = urls.slice(0, MAX_IMPORT);
	let added = 0;
	let existing = 0;
	let failed = 0;
	for (const url of selected) {
		signal.throwIfAborted();
		try {
			const data = await download(url, {
				...config,
				maxBytes: Math.min(config.maxBytes, MAX_IMPORT_BYTES)
			}, signal);
			const mime = imageMime(data);
			if (!mime) {
				failed++;
				continue;
			}
			let name = "";
			let tags = ["导入"];
			let category = "导入";
			if (visionSource(config) && mime !== "image/gif") try {
				const assessment = await assess(data, config, signal);
				if (assessment.name) name = assessment.name;
				if (assessment.tags.length) tags = assessment.tags;
				if (assessment.kind === "sticker" && assessment.category) category = assessment.category;
			} catch {
				signal.throwIfAborted();
			}
			if ((await collectSticker(config, data, tags, signal, {
				from: "import",
				kind: "sticker",
				category,
				...name ? { name } : {}
			})).existing) existing++;
			else added++;
		} catch {
			signal.throwIfAborted();
			failed++;
		}
	}
	return {
		total: selected.length,
		added,
		existing,
		failed
	};
};

export { importStickerUrls };