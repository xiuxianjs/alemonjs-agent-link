import { MediaError, MediaUnavailableError } from "./config.js";
import { imageMime } from "./download.js";
import { imageInfo } from "./image-info.js";
import { join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";

// src/media/stickers.ts
const SOURCES = [
	"manual",
	"auto",
	"forge",
	"import",
	"site",
	"file",
	"legacy"
];
const MANIFEST_MAX = 262144;
const MAX_ENTRIES = 500;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/u;
const readLocal = async (root, path, maxBytes) => {
	const base = await realpath(root);
	const candidate = await realpath(resolve(base, path));
	if (!candidate.startsWith(`${base}${sep}`)) throw new MediaError("表情文件必须位于素材目录内。");
	const file = await open(candidate, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > maxBytes) throw new MediaError("表情文件超过限制或不是普通文件。");
		const data = Buffer.alloc(maxBytes + 1);
		const result = await file.read(data, 0, data.length, 0);
		if (result.bytesRead > maxBytes) throw new MediaError("表情文件超过限制。");
		return data.subarray(0, result.bytesRead);
	} finally {
		await file.close();
	}
};
const hasControl = (value) => Array.from(value).some((char) => {
	const code = char.codePointAt(0) ?? 0;
	return code < 32 || code === 127;
});
const optionalInteger = (value, min, max) => value === void 0 || Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const validItem = (item) => {
	if (!item || typeof item !== "object" || Array.isArray(item)) return false;
	const row = item;
	return typeof row.id === "string" && ID_PATTERN.test(row.id) && typeof row.file === "string" && Array.isArray(row.tags) && row.tags.length <= 10 && row.tags.every((tag) => typeof tag === "string" && tag.trim() === tag && tag.length > 0 && tag.length <= 20) && (row.name === void 0 || typeof row.name === "string" && row.name.trim() === row.name && row.name.length > 0 && row.name.length <= 24) && (row.from === void 0 || SOURCES.includes(row.from)) && optionalInteger(row.addedAt, 0, Number.MAX_SAFE_INTEGER) && optionalInteger(row.uses, 0, Number.MAX_SAFE_INTEGER) && optionalInteger(row.lastUsed, 0, Number.MAX_SAFE_INTEGER) && optionalInteger(row.width, 1, 8192) && optionalInteger(row.height, 1, 8192) && optionalInteger(row.bytes, 1, 26214400) && (row.confidence === void 0 || typeof row.confidence === "number" && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1) && (row.emojiId === void 0 || typeof row.emojiId === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(row.emojiId)) && (row.kind === void 0 || row.kind === "sticker" || row.kind === "avatar") && (row.category === void 0 || typeof row.category === "string" && row.category.trim() === row.category && row.category.length > 0 && row.category.length <= 20 && !hasControl(row.category)) && (row.sourceUrl === void 0 || typeof row.sourceUrl === "string" && row.sourceUrl.length <= 2048 && /^https:\/\//u.test(row.sourceUrl) && !hasControl(row.sourceUrl)) && (row.license === void 0 || typeof row.license === "string" && row.license.length <= 80 && row.license.trim() === row.license && !hasControl(row.license));
};
/** Create the default library on first use without overwriting an existing manifest. */
const ensureStickerRoot = async (config) => {
	if (!config.stickerRoot) return;
	const root = config.stickerRoot;
	try {
		const info = await lstat(root);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError("表情素材目录无效。");
	} catch (error) {
		if (error instanceof MediaError) throw error;
		await mkdir(root, {
			recursive: true,
			mode: 448
		});
	}
	const manifest = join(root, "manifest.json");
	try {
		await lstat(manifest);
	} catch {
		await writeFile(manifest, "[]\n", {
			mode: 384,
			flag: "wx"
		}).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
	}
};
const listAssets = async (config) => {
	if (!config.stickerRoot) throw new MediaUnavailableError();
	await ensureStickerRoot(config);
	let data;
	try {
		data = JSON.parse((await readLocal(config.stickerRoot, "manifest.json", MANIFEST_MAX)).toString("utf8"));
	} catch (error) {
		throw error instanceof MediaError ? error : new MediaError("无法读取表情素材清单。");
	}
	if (!Array.isArray(data) || data.length > MAX_ENTRIES || !data.every(validItem)) throw new MediaError("表情清单格式无效或超过数量上限。");
	if (new Set(data.map((item) => item.id)).size !== data.length) throw new MediaError("表情清单的 id 不能重复。");
	return data;
};
const listStickers = async (config) => (await listAssets(config)).filter((item) => item.kind !== "avatar");
const readStickerPath = async (config, source, maxBytes) => {
	if (!config.stickerRoot) throw new MediaError("尚未配置表情素材目录。");
	const root = await realpath(config.stickerRoot);
	const target = await realpath(resolve(root, source));
	if (!target.startsWith(`${root}${sep}`)) throw new MediaError("本地图片必须位于表情素材目录内。");
	return await readLocal(root, relative(root, target), Math.min(maxBytes, config.maxBytes));
};
const chooseSticker = (items, query) => items.find((item) => item.id === query) ?? items.find((item) => item.name === query) ?? items.find((item) => item.tags.includes(query));
const loadSticker = async (item, config) => {
	const data = await readLocal(config.stickerRoot, item.file, config.maxBytes);
	if (!imageMime(data)) throw new MediaError("表情素材必须是 PNG、JPEG、WebP 或 GIF。");
	return data;
};
const tagsValid = (tags) => Array.isArray(tags) && tags.length <= 10 && tags.every((tag) => typeof tag === "string" && tag.trim() === tag && tag.length > 0 && tag.length <= 20) && new Set(tags).size === tags.length;
const mergeTags = (current, incoming) => {
	const merged = [...current];
	for (const tag of incoming) if (!merged.includes(tag) && merged.length < 10) merged.push(tag);
	return merged;
};
const normalizeMeta = (meta, info, bytes) => {
	const from = meta.from ?? "manual";
	if (!SOURCES.includes(from)) throw new MediaError("表情来源无效。");
	const name = typeof meta.name === "string" ? meta.name.replace(/\s+/gu, " ").trim() : void 0;
	if (name !== void 0 && (!name || Array.from(name).length > 24 || hasControl(name))) throw new MediaError("表情名称无效。");
	const confidence = meta.confidence;
	if (confidence !== void 0 && (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw new MediaError("表情判断置信度无效。");
	const addedAt = meta.addedAt ?? Date.now();
	if (!Number.isSafeInteger(addedAt) || addedAt < 0) throw new MediaError("表情入库时间无效。");
	const kind = meta.kind ?? "sticker";
	if (kind !== "sticker" && kind !== "avatar") throw new MediaError("图片类型无效。");
	const category = typeof meta.category === "string" ? meta.category.replace(/\s+/gu, " ").trim() : void 0;
	if (category !== void 0 && (!category || Array.from(category).length > 20 || hasControl(category))) throw new MediaError("图片分类无效。");
	const context = typeof meta.context === "string" ? meta.context.replace(/\s+/gu, " ").trim() : void 0;
	if (context !== void 0 && (!context || Array.from(context).length > 200 || hasControl(context))) throw new MediaError("图片用途说明无效。");
	const sourceUrl = typeof meta.sourceUrl === "string" ? meta.sourceUrl.trim() : void 0;
	if (sourceUrl !== void 0 && (!/^https:\/\//u.test(sourceUrl) || sourceUrl.length > 2048 || hasControl(sourceUrl))) throw new MediaError("图片来源地址无效。");
	const license = typeof meta.license === "string" ? meta.license.trim() : void 0;
	if (license !== void 0 && (!license || license.length > 80 || hasControl(license))) throw new MediaError("图片许可信息无效。");
	const width = info?.width ?? meta.width;
	const height = info?.height ?? meta.height;
	if (width !== void 0 && (!Number.isSafeInteger(width) || width < 1 || width > 8192) || height !== void 0 && (!Number.isSafeInteger(height) || height < 1 || height > 8192)) throw new MediaError("表情图片尺寸无效。");
	return {
		...name ? { name } : {},
		from,
		addedAt,
		...confidence !== void 0 ? { confidence } : {},
		kind,
		...category ? { category } : {},
		...context ? { context } : {},
		...sourceUrl ? { sourceUrl } : {},
		...license ? { license } : {},
		...width !== void 0 && height !== void 0 ? {
			width,
			height
		} : {},
		bytes
	};
};
const mutate = async (config, signal, change) => {
	if (!config.stickerRoot) throw new MediaError("尚未配置表情素材目录。");
	signal.throwIfAborted();
	await ensureStickerRoot(config);
	const root = await realpath(config.stickerRoot);
	const lockPath = join(root, ".agentlink-sticker.lock");
	let lock;
	try {
		lock = await open(lockPath, "wx", 384);
	} catch {
		throw new MediaError("表情库正在修改或锁文件未清理，请稍后检查。");
	}
	const temp = join(root, `.manifest-${randomUUID()}.tmp`);
	try {
		const manifest = join(root, "manifest.json");
		const stat = await lstat(manifest);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_MAX) throw new MediaError("表情清单必须是素材目录内不超过 256 KiB 的普通文件。");
		const before = await readFile(manifest);
		const result = await change(await listAssets({
			...config,
			stickerRoot: root
		}), root);
		const encoded = Buffer.from(`${JSON.stringify(result.items, null, 2)}\n`);
		if (encoded.length > MANIFEST_MAX) throw new MediaError("表情清单超过大小限制。");
		signal.throwIfAborted();
		const staged = await open(temp, "wx", 384);
		try {
			await staged.writeFile(encoded);
			await staged.sync();
		} finally {
			await staged.close();
		}
		signal.throwIfAborted();
		const current = await lstat(manifest);
		if (!current.isFile() || current.isSymbolicLink() || current.size > MANIFEST_MAX || !(await readFile(manifest)).equals(before)) throw new MediaError("表情清单被其他程序修改，请重试。");
		await rename(temp, manifest);
		return result.value;
	} finally {
		await unlink(temp).catch(() => void 0);
		await lock.close();
		await unlink(lockPath).catch(() => void 0);
	}
};
const pickEviction = (items) => {
	let best = -1;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (item.from !== "auto") continue;
		if (best < 0) {
			best = index;
			continue;
		}
		const previous = items[best];
		const uses = item.uses ?? 0;
		const previousUses = previous.uses ?? 0;
		const at = item.lastUsed ?? item.addedAt ?? 0;
		const previousAt = previous.lastUsed ?? previous.addedAt ?? 0;
		if (uses < previousUses || uses === previousUses && at < previousAt) best = index;
	}
	return best;
};
const removeStoredFile = async (config, file) => {
	if (!config.stickerRoot || !/^managed\/[a-f0-9]{16,64}\.(?:png|jpg|webp|gif)$/u.test(file)) return;
	try {
		const root = await realpath(config.stickerRoot);
		const target = resolve(root, file);
		if (!target.startsWith(`${root}${sep}`)) return;
		let current;
		try {
			current = await listAssets({
				...config,
				stickerRoot: root
			});
		} catch {
			return;
		}
		if (current.some((item) => item.file === file)) return;
		await unlink(target);
	} catch {}
};
const collectSticker = async (config, data, tags, signal, meta = {}) => {
	const ext = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif"
	}[imageMime(data) || ""];
	if (!ext || data.length > config.maxBytes) throw new MediaError("表情图片格式无效或超过大小限制。");
	if (!tagsValid(tags)) throw new MediaError("表情标签无效或重复。");
	const record = normalizeMeta(meta, imageInfo(data), data.length);
	const digest = createHash("sha256").update(data).digest("hex");
	const id = `s_${digest.slice(0, 24)}`;
	const filename = `${digest}.${ext}`;
	const result = await mutate(config, signal, async (items, root) => {
		const existing = items.find((item) => item.id === id);
		if (existing) {
			if (!(await loadSticker(existing, {
				...config,
				stickerRoot: root
			})).equals(data)) throw new MediaError("表情编号冲突，请检查素材清单。");
			const merged = {
				...existing,
				tags: mergeTags(existing.tags, tags),
				...existing.name || !record.name ? {} : { name: record.name },
				...existing.category || !record.category ? {} : { category: record.category },
				...existing.context || !record.context ? {} : { context: record.context },
				...existing.sourceUrl || !record.sourceUrl ? {} : { sourceUrl: record.sourceUrl },
				...existing.license || !record.license ? {} : { license: record.license }
			};
			return {
				items: items.map((item) => item.id === id ? merged : item),
				value: {
					id,
					existing: true,
					item: merged
				}
			};
		}
		let nextItems = items;
		const removed = [];
		while (nextItems.length >= config.stickerMaxItems) {
			const index = pickEviction(nextItems);
			if (index < 0) throw new MediaError("表情库已满，且没有可清理的自动收藏。");
			removed.push(nextItems[index].file);
			nextItems = nextItems.filter((_, position) => position !== index);
		}
		const directory = join(root, "managed");
		await mkdir(directory, {
			recursive: true,
			mode: 448
		});
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new MediaError("表情素材目录无效。");
		const path = join(directory, filename);
		let file;
		try {
			file = await open(path, "wx", 384);
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if (!(await readLocal(root, `managed/${filename}`, config.maxBytes)).equals(data)) throw new MediaError("表情文件冲突，请检查素材目录。");
		}
		if (file) try {
			await file.writeFile(data);
			await file.sync();
		} finally {
			await file.close();
		}
		const item = {
			id,
			file: `managed/${filename}`,
			tags,
			...record
		};
		return {
			items: [...nextItems, item],
			value: {
				id,
				existing: false,
				item,
				...removed.length ? { removed } : {}
			}
		};
	});
	for (const file of result.removed ?? []) await removeStoredFile(config, file);
	return {
		id: result.id,
		existing: result.existing,
		item: result.item
	};
};
const renameSticker = async (config, id, name, signal) => {
	const validName = typeof name === "string" && name.length > 0 && name.trim() === name && Array.from(name).length <= 24 && !hasControl(name);
	if (!ID_PATTERN.test(id) || !validName) throw new MediaError("表情编号或名称无效。");
	return await mutate(config, signal, (items) => {
		const index = items.findIndex((item) => item.id === id);
		if (index < 0) return {
			items,
			value: false
		};
		const updated = [...items];
		updated[index] = {
			...updated[index],
			name
		};
		return {
			items: updated,
			value: true
		};
	});
};
const updateSticker = async (config, id, tags, signal) => {
	if (!ID_PATTERN.test(id) || tags !== null && !tagsValid(tags)) throw new MediaError("表情编号或标签无效。");
	return await mutate(config, signal, (items) => {
		const index = items.findIndex((item) => item.id === id);
		if (index < 0) return {
			items,
			value: false
		};
		const updated = [...items];
		if (tags === null) updated.splice(index, 1);
		else updated[index] = {
			...updated[index],
			tags
		};
		return {
			items: updated,
			value: true
		};
	});
};
const setStickerEmoji = async (config, id, emojiId, signal) => {
	if (!ID_PATTERN.test(id) || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId)) throw new MediaError("表情编号或 QQ 收藏标识无效。");
	return await mutate(config, signal, (items) => {
		const index = items.findIndex((item) => item.id === id);
		if (index < 0) return {
			items,
			value: false
		};
		const updated = [...items];
		updated[index] = {
			...updated[index],
			emojiId
		};
		return {
			items: updated,
			value: true
		};
	});
};
const markStickerUsed = async (config, id, signal) => {
	if (!ID_PATTERN.test(id)) return false;
	return await mutate(config, signal, (items) => {
		const index = items.findIndex((item) => item.id === id);
		if (index < 0) return {
			items,
			value: false
		};
		const updated = [...items];
		updated[index] = {
			...updated[index],
			uses: (updated[index].uses ?? 0) + 1,
			lastUsed: Date.now()
		};
		return {
			items: updated,
			value: true
		};
	});
};
/** Atomic management edits use the same manifest lock as collection and usage. */
const editStickerAsset = async (config, id, expected, patch) => {
	if (!ID_PATTERN.test(id) || typeof expected !== "string") throw new MediaError("表情编号无效。");
	await mutate(config, AbortSignal.timeout(1e4), (items) => {
		const index = items.findIndex((item) => item.id === id);
		if (index < 0 || stickerRevision(items[index]) !== expected) throw new MediaError("配置已更新，请刷新后重试。");
		const updated = [...items];
		if (patch === null) updated.splice(index, 1);
		else {
			const item = {
				...items[index],
				name: patch.name,
				tags: patch.tags
			};
			if (!validItem(item) || hasControl(patch.name) || !tagsValid(patch.tags)) throw new MediaError("名称或标签无效。");
			updated[index] = item;
		}
		return {
			items: updated,
			value: void 0
		};
	});
};
const stickerRevision = (item) => createHash("sha256").update(JSON.stringify(item)).digest("hex");

export { chooseSticker, collectSticker, editStickerAsset, ensureStickerRoot, listAssets, listStickers, loadSticker, markStickerUsed, readStickerPath, renameSticker, setStickerEmoji, stickerRevision, updateSticker };