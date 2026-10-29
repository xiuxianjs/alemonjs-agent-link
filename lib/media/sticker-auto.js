import { getMediaConfig } from "./config.js";
import { withBudgetScope } from "../billing/budget.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { downloadAttachment, imageMime } from "./download.js";
import { imageInfo } from "./image-info.js";
import { assessSticker } from "./providers.js";
import { collectSticker, setStickerEmoji } from "./stickers.js";
import { bindOnebotImageResolver } from "./onebot-images.js";
import { addOnebotFavoriteSticker } from "./onebot-favorites.js";
import { logger } from "alemonjs";

// src/media/sticker-auto.ts
const autoStickerSettings = (config) => {
	const { autoCollect = true, autoOwnerPrivate = true, autoGroups = [], autoLabel = true, autoMaxPerHour = 20, autoDetect = true, autoMinConfidence = .6, autoMaxBytes = 2097152, autoMaxSide = 1024, autoAllGroups = Array.isArray(autoGroups) ? autoGroups.length === 0 : false, autoQQSync = true } = config.modules?.settings?.stickers || {};
	if (typeof autoCollect !== "boolean" || typeof autoOwnerPrivate !== "boolean" || typeof autoLabel !== "boolean" || typeof autoDetect !== "boolean" || typeof autoAllGroups !== "boolean" || typeof autoQQSync !== "boolean" || !Array.isArray(autoGroups) || autoGroups.length > 100 || autoGroups.some((value) => typeof value !== "string" || value.length < 3 || value.length > 200 || !value.includes(":")) || !Number.isSafeInteger(autoMaxPerHour) || Number(autoMaxPerHour) < 1 || Number(autoMaxPerHour) > 100 || typeof autoMinConfidence !== "number" || !Number.isFinite(autoMinConfidence) || autoMinConfidence < 0 || autoMinConfidence > 1 || !Number.isSafeInteger(autoMaxBytes) || Number(autoMaxBytes) < 1024 || Number(autoMaxBytes) > 26214400 || !Number.isSafeInteger(autoMaxSide) || Number(autoMaxSide) < 64 || Number(autoMaxSide) > 2048) throw new Error("表情自动收集设置无效。");
	return {
		enabled: autoCollect && !config.modules?.disabled?.includes("stickers") && config.aiEnabled !== false,
		ownerPrivate: autoOwnerPrivate,
		groups: autoGroups,
		allGroups: autoAllGroups,
		label: autoLabel,
		maxPerHour: Number(autoMaxPerHour),
		detect: autoDetect,
		minConfidence: autoMinConfidence,
		maxBytes: Number(autoMaxBytes),
		maxSide: Number(autoMaxSide),
		qqSync: autoQQSync
	};
};
var AutoStickerCollector = class {
	deps;
	queue = [];
	seen = /* @__PURE__ */ new Map();
	attempts = [];
	running = false;
	generation = 0;
	active;
	constructor(deps) {
		this.deps = deps;
	}
	enqueue(event) {
		const settings = autoStickerSettings(this.deps.config());
		const platform = event.Platform || "";
		const userId = event.UserId || "";
		const channelId = event.IsPrivate ? `private:${JSON.stringify([platform, userId])}` : event.ChannelId || "";
		if (!settings.enabled || event.IsBot || !platform || !userId || !channelId || !event.MessageId || (event.IsPrivate ? !(settings.ownerPrivate && event.IsMaster) : !settings.allGroups && !settings.groups.includes(`${platform}:${channelId}`))) return 0;
		let vision = false;
		try {
			vision = Boolean(this.deps.media().vision);
		} catch {}
		const items = (event.MessageMedia || []).map((item, index) => ({
			item,
			index
		})).filter(({ item, index }) => {
			if (item._onebotQuoted) return false;
			const resolvable = Boolean(item.Url) || platform === "onebot" && index < 5 && Boolean(item._onebotImageFile);
			if (item.Type === "sticker") return resolvable;
			return settings.detect && vision && ["image", "animation"].includes(item.Type) && resolvable;
		}).slice(0, 3);
		const lookup = items.some(({ item, index }) => platform === "onebot" && index < 5 && Boolean(item._onebotImageFile)) ? bindOnebotImageResolver(event) : void 0;
		const now = Date.now();
		this.attempts = this.attempts.filter((at) => now - at < 36e5);
		for (const [key, at] of this.seen) if (now - at >= 36e5) this.seen.delete(key);
		let accepted = 0;
		for (const { item, index } of items) {
			const key = JSON.stringify([
				platform,
				channelId,
				event.MessageId,
				index
			]);
			if (this.seen.has(key) || this.queue.length >= 8 || this.attempts.length >= settings.maxPerHour) continue;
			this.seen.set(key, now);
			this.attempts.push(now);
			this.queue.push({
				platform,
				channelId,
				userId,
				event: { ...event },
				item: { ...item },
				index,
				lookup,
				label: settings.label,
				explicit: item.Type === "sticker",
				generation: this.generation
			});
			accepted++;
		}
		if (accepted && !this.running) this.drain();
		return accepted;
	}
	reset() {
		this.generation++;
		this.queue.length = 0;
		this.active?.abort();
	}
	async drain() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.length) {
				const job = this.queue.shift();
				const controller = new AbortController();
				this.active = controller;
				try {
					const current = autoStickerSettings(this.deps.config());
					if (!current.enabled || job.generation !== this.generation || (job.channelId.startsWith("private:") ? !current.ownerPrivate : !current.allGroups && !current.groups.includes(`${job.platform}:${job.channelId}`))) continue;
					const media = this.deps.media();
					if (!media.stickerRoot) continue;
					if (!job.explicit && (!current.detect || !media.vision)) continue;
					const maxBytes = job.explicit ? media.maxBytes : current.maxBytes;
					if (job.item.FileSize && job.item.FileSize > maxBytes) continue;
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(media.timeoutMs)]);
					const downloadConfig = {
						...media,
						maxBytes
					};
					let data;
					if (job.item.Url) try {
						const candidate = await this.deps.download(job.item.Url, downloadConfig, signal);
						if (candidate.length <= maxBytes && imageMime(candidate)) data = candidate;
					} catch {
						signal.throwIfAborted();
					}
					if (!data && job.lookup) {
						const value = await job.lookup(job.index);
						signal.throwIfAborted();
						if (value?.base64 && value.base64.length <= Math.ceil(maxBytes * 4 / 3) + 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.base64)) {
							const candidate = Buffer.from(value.base64, "base64");
							if (candidate.length <= maxBytes && imageMime(candidate)) data = candidate;
						} else if (value?.url) data = await this.deps.download(value.url, downloadConfig, signal);
					}
					if (!data || data.length > maxBytes || !imageMime(data)) throw new Error("表情图片不可用。");
					const info = imageInfo(data);
					if (!info && !job.explicit) continue;
					if (info) {
						const ratio = info.width / info.height;
						if (info.width > current.maxSide || info.height > current.maxSide || ratio < .75 || ratio > 1.33) continue;
					}
					let assessment;
					if (media.vision && (current.detect || job.explicit && current.label) && imageMime(data) !== "image/gif") try {
						assessment = await withBudgetScope({
							platform: job.platform,
							channelId: job.channelId,
							userId: job.userId
						}, () => this.deps.assess(data, media, signal));
					} catch {
						signal.throwIfAborted();
					}
					if (!job.explicit) {
						if (!assessment || !assessment.suitable || assessment.confidence < current.minConfidence) continue;
					} else if (assessment && !assessment.suitable) continue;
					const kind = job.explicit ? assessment?.kind === "avatar" ? "avatar" : "sticker" : assessment?.kind ?? (assessment?.sticker ? "sticker" : "other");
					const category = assessment?.category || (kind === "avatar" ? "头像" : "未分类");
					const tags = assessment?.tags.length ? assessment.tags : [kind === "avatar" ? "头像" : "表情"];
					if (!job.explicit && kind === "other") continue;
					signal.throwIfAborted();
					if (job.generation !== this.generation) continue;
					const collected = await this.deps.collect(media, data, tags, signal, {
						from: "auto",
						kind,
						category,
						...assessment?.name ? { name: assessment.name } : {},
						...assessment ? { confidence: assessment.confidence } : {},
						...info ? {
							width: info.width,
							height: info.height
						} : {}
					});
					if (current.qqSync && !collected.existing && this.deps.favorite && this.deps.setEmoji) {
						const emojiId = await this.deps.favorite(job.event, data, assessment?.name).catch(() => void 0);
						if (emojiId) await this.deps.setEmoji(media, collected.id, emojiId, signal).catch(() => void 0);
					}
				} catch {
					if (!controller.signal.aborted) this.deps.failed();
				} finally {
					if (this.active === controller) this.active = void 0;
				}
			}
		} finally {
			this.running = false;
		}
	}
};
const autoStickerCollector = new AutoStickerCollector({
	config: getDSHConfig,
	media: getMediaConfig,
	download: downloadAttachment,
	assess: assessSticker,
	collect: collectSticker,
	favorite: addOnebotFavoriteSticker,
	setEmoji: setStickerEmoji,
	failed: () => logger.warn("Automatic sticker collection failed")
});

export { AutoStickerCollector, autoStickerCollector, autoStickerSettings };