import { MediaError, getMediaConfig } from "../media/config.js";
import { withBudgetScope } from "../billing/budget.js";
import { downloadAttachment, imageMime } from "../media/download.js";
import { assessSticker } from "../media/providers.js";
import { chooseSticker, collectSticker, listStickers, loadSticker, markStickerUsed, readStickerPath, renameSticker, updateSticker } from "../media/stickers.js";
import { renderSticker } from "../media/sticker-forge.js";
import { deleteFavoriteDirect } from "../media/onebot-direct.js";
import { getActiveOneBotConnection } from "../onebot/index.js";
import { takeRecentImage } from "../media/recent.js";
import { lstat, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

// src/modules/stickers.ts
const stickerModule = () => ({
	id: "stickers",
	name: "表情包",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		api.tool({
			name: "list_stickers",
			readOnly: true,
			description: "查询当前配置的表情素材。可按名称、编号或标签的部分文字搜索；只返回编号、名称和标签，不返回本机路径。",
			parameters: {
				type: "object",
				properties: { query: {
					type: "string",
					maxLength: 40
				} },
				additionalProperties: false
			},
			available: (context) => !context.autonomous && Boolean(context.onSticker),
			execute: async ({ query }, context) => {
				try {
					context.signal.throwIfAborted();
					const text = String(query || "").trim().toLowerCase();
					const config = getMediaConfig();
					if (!config.stickerRoot) return {
						ok: false,
						message: "尚未配置表情素材目录。"
					};
					const items = (await listStickers(config)).filter((item) => !text || item.id.toLowerCase().includes(text) || (item.name || "").toLowerCase().includes(text) || item.tags.some((tag) => tag.toLowerCase().includes(text)));
					context.signal.throwIfAborted();
					return {
						ok: true,
						count: items.length,
						items: items.map(({ id, tags, name, category, context }) => ({
							id,
							...name ? { name } : {},
							...category ? { category } : {},
							...context ? { context: context.slice(0, 120) } : {},
							tags
						}))
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "无法读取表情素材。"
					};
				}
			}
		});
		api.tool({
			name: "send_sticker",
			description: "根据编号、完整名称或完整标签向当前会话发送一个已有表情，用户要求表情时可先查询。只在平台回执成功后返回成功；不支持指定其他接收人。",
			parameters: {
				type: "object",
				required: ["query"],
				properties: { query: {
					type: "string",
					minLength: 1,
					maxLength: 40
				} },
				additionalProperties: false
			},
			available: (context) => !context.autonomous && Boolean(context.onSticker),
			execute: async ({ query }, context) => {
				try {
					context.signal.throwIfAborted();
					const config = getMediaConfig();
					if (!config.stickerRoot) return {
						ok: false,
						message: "尚未配置表情素材目录。"
					};
					const item = chooseSticker(await listStickers(config), String(query).trim());
					if (!item) return {
						ok: false,
						message: "没有找到该编号或完整标签的表情。"
					};
					const data = await loadSticker(item, config);
					context.signal.throwIfAborted();
					if (!context.onSticker) return {
						ok: false,
						message: "当前会话不支持发送表情。"
					};
					await context.onSticker(item, data);
					await markStickerUsed(config, item.id, context.signal).catch(() => void 0);
					return {
						ok: true,
						id: item.id,
						...item.name ? { name: item.name } : {},
						message: "平台已接受表情发送。"
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "表情发送未获成功回执，请勿自动重试。"
					};
				}
			}
		});
		api.tool({
			name: "make_sticker",
			description: "把当前消息里的唯一图片、本会话最近一张图片，或表情素材库中的一张，做成新的方形表情包：可上下配字、裁切或留边，保存进素材库并默认发送。仅在主人明确要求制作、二创、加字或修改表情时使用；主人没给文字时可据图拟一句不超过 40 字的短句，不确定就不配字；动图只保留第一帧。",
			parameters: {
				type: "object",
				properties: {
					source: {
						type: "string",
						enum: [
							"current",
							"recent",
							"library"
						]
					},
					id: {
						type: "string",
						minLength: 1,
						maxLength: 40
					},
					text: {
						type: "string",
						maxLength: 40
					},
					position: {
						type: "string",
						enum: ["top", "bottom"]
					},
					size: {
						type: "integer",
						minimum: 128,
						maximum: 512
					},
					fit: {
						type: "string",
						enum: ["cover", "contain"]
					},
					tags: {
						type: "array",
						maxItems: 10,
						items: {
							type: "string",
							maxLength: 20
						}
					},
					send: { type: "boolean" }
				},
				additionalProperties: false
			},
			available: (context) => context.owner && !context.autonomous,
			execute: async ({ source, id, text, position, size, fit, tags, send }, context) => {
				const input = context.userText || "";
				const asked = /做成|做一?[个张]|制作|生成|变成|弄成|搞成|整成|改成|加字|配字|写字|二创|梗图|表情包/u.test(input);
				const denied = /(?:不要|别|不用|不需要|不许|禁止).{0,16}(?:做|制作|生成|变成|加字|配字|改)|(?:能|可以|怎么).{0,16}(?:做|制作|生成).{0,30}[吗么？?]/u.test(input);
				if (!context.owner || context.autonomous || !asked || denied) return {
					ok: false,
					message: "需要主人明确要求制作表情。"
				};
				try {
					context.signal.throwIfAborted();
					const config = getMediaConfig();
					if (!config.stickerRoot) return {
						ok: false,
						message: "尚未配置表情素材目录。"
					};
					let data;
					let sourceId = "current";
					if (source === "library") {
						const item = chooseSticker(await listStickers(config), String(id || "").trim());
						if (!item) return {
							ok: false,
							message: "没有找到该编号或完整标签的表情。"
						};
						data = await loadSticker(item, config);
						sourceId = item.id;
					} else if (source === "recent") {
						const recent = await takeRecentImage(context.platform, context.channelId, context.signal, context.userId);
						if (!recent) return {
							ok: false,
							message: "本会话最近没有可用的图片。"
						};
						data = recent;
						sourceId = "recent";
					} else {
						if (!context.onCurrentImages) return {
							ok: false,
							message: "当前会话无法读取当前图片，请改用素材编号。"
						};
						const images = await context.onCurrentImages(context.signal);
						context.signal.throwIfAborted();
						if (images.length !== 1) return {
							ok: false,
							message: "当前消息必须恰好有一张图片才能制作表情。"
						};
						data = images[0];
					}
					const rendered = await renderSticker(data, {
						text: typeof text === "string" ? text : "",
						position: position === "top" ? "top" : "bottom",
						size: typeof size === "number" ? size : 300,
						fit: fit === "contain" ? "contain" : "cover"
					}, context.signal);
					const caption = typeof text === "string" ? text.replace(/\s+/gu, " ").trim().slice(0, 24) : "";
					const saved = await collectSticker(config, rendered.data, Array.isArray(tags) && tags.length ? tags : ["表情"], context.signal, {
						from: "forge",
						kind: "sticker",
						category: "未分类",
						...caption ? { name: caption } : {}
					});
					const item = (await listStickers(config)).find((value) => value.id === saved.id);
					if (!item) throw new MediaError("表情已保存但无法读取清单。");
					let sent = false;
					let sendError;
					if (send !== false && context.onSticker) try {
						await context.onSticker(item, rendered.data);
						await markStickerUsed(config, item.id, context.signal).catch(() => void 0);
						sent = true;
					} catch (error) {
						context.signal.throwIfAborted();
						sendError = error instanceof MediaError ? error.message : "平台未确认发送。";
					}
					return {
						ok: true,
						id: item.id,
						tags: item.tags,
						sent,
						existing: saved.existing,
						animated: rendered.animated,
						source: sourceId,
						message: `${rendered.animated ? "动图只保留第一帧；" : ""}${saved.existing ? "表情已生成（素材库已有同款）" : "表情已生成并收藏"}，${send === false ? "按要求只保存，未发送。" : sent ? "已交给平台发送。" : sendError ? `但发送未完成：${sendError}` : "当前会话不能发送，可稍后用 send_sticker。"}`
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "表情制作未完成。"
					};
				}
			}
		});
		api.tool({
			name: "collect_sticker",
			description: "主人明确要求收藏当前消息、引用里的唯一图片，或本会话最近一张图片作为表情时调用。按当前图片实际可见内容提供简短标签，不确定就留空；只能使用本轮或最近附件，不可指定 URL。",
			parameters: {
				type: "object",
				properties: {
					tags: {
						type: "array",
						maxItems: 10,
						items: {
							type: "string",
							maxLength: 20
						}
					},
					kind: {
						type: "string",
						enum: ["sticker", "avatar"]
					},
					category: {
						type: "string",
						maxLength: 20
					}
				},
				additionalProperties: false
			},
			available: (context) => context.owner && !context.autonomous,
			execute: async ({ tags, kind, category }, context) => {
				const input = context.userText || "";
				const asked = /(?:收藏|收下|保存|存入|加入).{0,20}(?:表情|图片|这张图|这张)|(?:表情|图片|这张图).{0,20}(?:收藏|保存|收下|存入)/u.test(input);
				const denied = /(?:不要|别|不许|禁止|不用|不需要|不能).{0,16}(?:收藏|保存|收下|存入)|能.{0,12}(?:收藏|保存).{0,12}[吗么？?]/u.test(input);
				if (!context.owner || context.autonomous || !asked || denied) return {
					ok: false,
					message: "需要主人明确要求收藏当前图片。"
				};
				try {
					const data = (context.onStickerCollect ? await context.onStickerCollect(context.signal).catch(() => {
						context.signal.throwIfAborted();
					}) : void 0) || await takeRecentImage(context.platform, context.channelId, context.signal, context.userId);
					if (!data) return {
						ok: false,
						message: "当前消息和本会话最近都没有可收藏的图片。"
					};
					const result = await collectSticker(getMediaConfig(), data, Array.isArray(tags) ? tags : [], context.signal, {
						from: "manual",
						kind: kind === "avatar" ? "avatar" : "sticker",
						category: typeof category === "string" ? category : void 0
					});
					return {
						ok: true,
						...result,
						message: result.existing ? "这张表情已在素材库中。" : "表情已收藏到素材库。"
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "未能收藏表情。"
					};
				}
			}
		});
		api.tool({
			name: "add_sticker",
			description: "主人明确要求把某个 HTTPS 图片地址，或表情素材目录内的本地图片，加入表情库时使用。不能读取目录外路径；URL 仍受媒体域名、大小、超时和重定向限制。",
			parameters: {
				type: "object",
				required: ["source"],
				properties: {
					source: {
						type: "string",
						minLength: 1,
						maxLength: 2048
					},
					name: {
						type: "string",
						minLength: 1,
						maxLength: 24
					},
					kind: {
						type: "string",
						enum: ["sticker", "avatar"]
					},
					category: {
						type: "string",
						maxLength: 20
					},
					tags: {
						type: "array",
						maxItems: 10,
						items: {
							type: "string",
							maxLength: 20
						}
					}
				},
				additionalProperties: false
			},
			available: (context) => context.owner && !context.autonomous,
			execute: async ({ source, name, tags, kind, category }, context) => {
				const input = context.userText || "";
				const asked = /(?:收藏|收下|保存|存入|加入|导入|添加|收进|收录|加进).{0,20}(?:表情|图片|这张|这个|链接|地址|url|图)|(?:表情|图片|链接|地址|url).{0,20}(?:收藏|保存|收下|存入|导入|添加|收进|收录|加进)/iu.test(input);
				const denied = /(?:不要|别|不许|禁止|不用|不需要|不能).{0,16}(?:收藏|保存|收下|存入|导入|添加)|能.{0,12}(?:收藏|保存|导入).{0,12}[吗么？?]/u.test(input);
				if (!context.owner || context.autonomous || !asked || denied) return {
					ok: false,
					message: "需要主人明确要求添加图片。"
				};
				try {
					context.signal.throwIfAborted();
					const config = getMediaConfig();
					const text = String(source).trim();
					const url = /^https?:\/\//iu.test(text);
					if (!config.stickerRoot) return {
						ok: false,
						message: "尚未配置表情素材目录。"
					};
					if (url && !/^https:\/\//iu.test(text)) return {
						ok: false,
						message: "图片地址必须是 HTTPS。"
					};
					const data = url ? await downloadAttachment(text, config, context.signal) : await readStickerPath(config, text, 5242880);
					context.signal.throwIfAborted();
					if (!imageMime(data) || data.length > config.maxBytes) return {
						ok: false,
						message: "图片格式不支持或超过大小限制。"
					};
					const cleanName = typeof name === "string" ? name.replace(/\s+/gu, " ").trim().slice(0, 24) : "";
					const assetKind = kind === "avatar" ? "avatar" : "sticker";
					const result = await collectSticker(config, data, Array.isArray(tags) && tags.length ? tags : [assetKind === "avatar" ? "头像" : "表情"], context.signal, {
						from: "manual",
						kind: assetKind,
						...typeof category === "string" ? { category } : {},
						...cleanName ? { name: cleanName } : {}
					});
					return {
						ok: true,
						id: result.id,
						...result.item.name ? { name: result.item.name } : {},
						tags: result.item.tags,
						message: result.existing ? "这张表情已在素材库中。" : "图片已加入素材库。"
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "图片添加未完成。"
					};
				}
			}
		});
		api.tool({
			name: "import_image_folder",
			description: "主人明确要求批量导入素材目录内某个子目录的图片时使用。只读该目录内的图片文件，逐张判断是头像还是表情并分类；最多处理 30 张，不读取目录外路径。",
			parameters: {
				type: "object",
				required: ["path"],
				properties: {
					path: {
						type: "string",
						minLength: 1,
						maxLength: 200
					},
					kind: {
						type: "string",
						enum: ["sticker", "avatar"]
					},
					limit: {
						type: "integer",
						minimum: 1,
						maximum: 30
					}
				},
				additionalProperties: false
			},
			available: (context) => context.owner && !context.autonomous,
			execute: async ({ path, kind, limit }, context) => {
				const input = context.userText || "";
				const asked = /(?:导入|批量|目录|文件夹|扫一遍|收进).{0,20}(?:图片|头像|表情|目录|文件夹)|(?:图片|头像|表情).{0,20}(?:导入|批量|收进)/u.test(input);
				const denied = /(?:不要|别|不许|禁止|不用|不需要|不能).{0,16}(?:导入|批量|收进)/u.test(input);
				if (!context.owner || context.autonomous || !asked || denied) return {
					ok: false,
					message: "需要主人明确要求批量导入图片。"
				};
				try {
					const config = getMediaConfig();
					if (!config.stickerRoot) return {
						ok: false,
						message: "尚未配置表情素材目录。"
					};
					const root = await realpath(config.stickerRoot);
					const directory = await realpath(resolve(root, String(path)));
					if (!directory.startsWith(`${root}${sep}`)) return {
						ok: false,
						message: "导入目录必须位于素材目录内。"
					};
					const info = await lstat(directory);
					if (!info.isDirectory() || info.isSymbolicLink()) return {
						ok: false,
						message: "导入路径不是普通目录。"
					};
					const max = Math.min(30, Math.max(1, Number(limit) || 20));
					const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp|gif)$/iu.test(entry.name)).slice(0, max);
					let added = 0;
					let existing = 0;
					let failed = 0;
					let skipped = 0;
					for (const entry of entries) {
						context.signal.throwIfAborted();
						try {
							const relativePath = relative(root, resolve(directory, entry.name));
							const data = await readStickerPath(config, relativePath, 5242880);
							let kindValue = kind === "avatar" ? "avatar" : "sticker";
							let category = kindValue === "avatar" ? "头像" : "未分类";
							let name;
							let tags = kindValue === "avatar" ? ["头像"] : ["导入"];
							if (config.vision && imageMime(data) !== "image/gif") try {
								const assessment = await withBudgetScope({
									platform: context.platform,
									channelId: context.channelId,
									userId: context.userId
								}, () => assessSticker(data, config, context.signal));
								if (assessment.kind === "avatar" || assessment.kind === "sticker") kindValue = assessment.kind;
								if (assessment.kind === "other") {
									skipped++;
									continue;
								}
								if (assessment.category) category = assessment.category;
								if (assessment.name) name = assessment.name;
								if (assessment.tags.length) tags = assessment.tags;
							} catch {
								context.signal.throwIfAborted();
							}
							if ((await collectSticker(config, data, tags, context.signal, {
								from: "file",
								kind: kindValue,
								category,
								...name ? { name } : {}
							})).existing) existing++;
							else added++;
						} catch {
							context.signal.throwIfAborted();
							failed++;
						}
					}
					return {
						ok: true,
						total: entries.length,
						added,
						existing,
						failed,
						skipped,
						message: `已处理 ${entries.length} 张：新增 ${added}，已有 ${existing}，跳过 ${skipped}，失败 ${failed}。`
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "批量导入未完成。"
					};
				}
			}
		});
		api.tool({
			name: "manage_sticker",
			description: "主人明确要求时修改指定表情编号的名称、标签，或从清单移除表情；移除会从清单删除并尝试删除对应 QQ 收藏，但保留原图片文件。必须在用户本轮文字中给出完整编号。",
			parameters: {
				type: "object",
				required: ["id", "action"],
				properties: {
					id: {
						type: "string",
						minLength: 1,
						maxLength: 40
					},
					action: {
						type: "string",
						enum: [
							"tags",
							"name",
							"remove"
						]
					},
					tags: {
						type: "array",
						maxItems: 10,
						items: {
							type: "string",
							maxLength: 20
						}
					},
					name: {
						type: "string",
						minLength: 1,
						maxLength: 24
					}
				},
				additionalProperties: false
			},
			available: (context) => context.private && context.owner && !context.autonomous,
			execute: async ({ id, action, tags, name }, context) => {
				const input = context.userText || "";
				const identifier = String(id);
				const mentionsId = /^[a-zA-Z0-9_-]{1,40}$/u.test(identifier) && new RegExp(`(?:^|[^a-zA-Z0-9_-])${identifier}(?![a-zA-Z0-9_-])`, "u").test(input);
				const allowed = action === "remove" ? /删除|移除|去掉/u.test(input) : action === "name" ? /改名|名字|名称|命名|起名|叫/u.test(input) : /修改|设置|更改|更新|标注/u.test(input) && /标签/u.test(input);
				const denied = /(?:不要|别|不许|禁止|不用|不需要|不能).{0,16}(?:删除|移除|修改|更新|标注|改名|名字|命名)|能.{0,12}(?:删除|移除|修改|更新|改名|名字|命名).{0,40}[吗么？?]/u.test(input);
				if (!context.private || !context.owner || context.autonomous || ![
					"tags",
					"name",
					"remove"
				].includes(String(action)) || !mentionsId || !allowed || denied || action === "tags" && !Array.isArray(tags) || action === "name" && typeof name !== "string") return {
					ok: false,
					message: "需要主人明确指定表情编号和操作。"
				};
				try {
					const config = getMediaConfig();
					let qqDeleted = false;
					if (action === "remove") {
						const target = (await listStickers(config)).find((item) => item.id === identifier);
						const connection = getActiveOneBotConnection();
						if (target?.emojiId && connection) qqDeleted = await deleteFavoriteDirect(connection, target.emojiId);
					}
					const changed = action === "name" ? await renameSticker(config, identifier, String(name), context.signal) : await updateSticker(config, identifier, action === "remove" ? null : tags, context.signal);
					return {
						ok: changed,
						...action === "remove" ? { qqDeleted } : {},
						message: !changed ? "未找到该表情编号。" : action === "remove" ? `已从表情清单移除，原图片文件保留。${qqDeleted ? "QQ 收藏已删除。" : ""}` : action === "name" ? "表情名称已更新。" : "表情标签已更新。"
					};
				} catch (error) {
					context.signal.throwIfAborted();
					return {
						ok: false,
						message: error instanceof MediaError ? error.message : "表情清单修改未完成。"
					};
				}
			}
		});
	}
});

export { stickerModule };