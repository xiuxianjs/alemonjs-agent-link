import { audioFormat, imageMime } from "../media/download.js";
import { isPersonalKeyCommand } from "../credentials/personal.js";
import { numericId } from "./config.js";
import { OneBotError } from "./connection.js";
import { parseSegments, validMessageId } from "./events.js";
import { readImageFile, readRecordFile } from "./record-file.js";
import { ResultCode, createResult, markdownToPlainText } from "alemonjs";

// src/onebot/actions.ts
const formatSegments = (items) => {
	if (!Array.isArray(items) || items.length > 200) throw new Error("消息格式无效。");
	return items.map((item) => {
		if (item.type === "Mention") return {
			type: "at",
			data: { qq: numericId(item.value) }
		};
		if (["Text", "MarkdownOriginal"].includes(item.type)) return {
			type: "text",
			data: { text: String(item.value) }
		};
		if (item.type === "Markdown") return {
			type: "text",
			data: { text: markdownToPlainText(item.value) }
		};
		throw new Error("此消息格式尚不能通过 OneBot 发送。");
	});
};
var OneBotActions = class {
	connection;
	policy;
	constructor(connection, policy) {
		this.connection = connection;
		this.policy = policy;
	}
	target(payload) {
		const event = payload.event || {};
		const target = payload.target || payload.params?.target || event.Target || (event.IsPrivate ? {
			scope: "c2c",
			targetId: event.UserId
		} : {
			scope: "group",
			targetId: event.ChannelId
		});
		const botId = target.BotId || payload.BotId || event.BotId;
		if (botId && botId !== this.connection.config.selfId) throw new Error("机器人账号不匹配。");
		if (!["group", "c2c"].includes(target.scope)) throw new Error("OneBot 目标范围不支持。");
		return {
			scope: target.scope,
			id: numericId(target.targetId)
		};
	}
	async send(payload, segments) {
		const target = this.target(payload);
		const reply = validMessageId(payload.params?.replyId);
		const body = reply ? [{
			type: "reply",
			data: { id: reply }
		}, ...segments] : segments;
		const result = await this.connection.call(target.scope === "group" ? "send_group_msg" : "send_private_msg", {
			[target.scope === "group" ? "group_id" : "user_id"]: Number(target.id),
			message: body,
			auto_escape: false
		});
		const id = validMessageId(result?.message_id);
		if (!id) throw new OneBotError("protocol");
		return {
			id,
			messageId: id
		};
	}
	async action(frame) {
		try {
			const payload = frame.payload || {};
			if (payload.BotId && payload.BotId !== this.connection.config.selfId || payload.event?.BotId && payload.event.BotId !== this.connection.config.selfId || payload.event?.Platform && payload.event.Platform !== "onebot") throw new Error("平台账号不匹配。");
			const action = frame.action;
			const p = payload.params || {};
			let data;
			if ([
				"message.send",
				"message.send.target",
				"message.send.channel",
				"message.send.user"
			].includes(action)) {
				if (!payload.target && action.endsWith(".channel")) payload.target = {
					scope: "group",
					targetId: payload.ChannelId
				};
				if (!payload.target && action.endsWith(".user")) payload.target = {
					scope: "c2c",
					targetId: payload.UserId
				};
				data = await this.send(payload, formatSegments(p.format || []));
			} else if ([
				"media.send",
				"media.send.channel",
				"media.send.user"
			].includes(action)) {
				if (!["image", "audio"].includes(p.type) || typeof p.data !== "string" || !/^[a-zA-Z0-9+/]+={0,2}$/u.test(p.data) || p.data.length > 35651584) throw new Error("OneBot 媒体仅支持有界 base64 图片或语音。");
				data = await this.send(payload, [...p.content ? [{
					type: "text",
					data: { text: String(p.content).slice(0, 1e3) }
				}] : [], {
					type: p.type === "audio" ? "record" : "image",
					data: { file: `base64://${p.data}` }
				}]);
			} else if (action === "guild.info") {
				const target = this.target(payload);
				if (target.scope !== "group" || payload.GuildId && String(payload.GuildId) !== target.id) throw new OneBotError("protocol");
				const info = await this.connection.call("get_group_info", {
					group_id: Number(target.id),
					no_cache: true
				});
				if (!info || String(info.group_id) !== target.id) throw new OneBotError("protocol");
				data = {
					GuildId: target.id,
					GuildName: info.group_name,
					MemberCount: info.member_count
				};
			} else if (action === "member.info" || action === "member.list") {
				const target = this.target(payload);
				const groupId = payload.GuildId || p.guildId;
				if (target.scope !== "group" || groupId && String(groupId) !== target.id) throw new OneBotError("protocol");
				const project = (value) => {
					if (!value || typeof value !== "object") throw new OneBotError("protocol");
					const row = value;
					if (String(row.group_id) !== target.id) throw new OneBotError("protocol");
					return {
						GuildId: target.id,
						UserId: numericId(String(row.user_id)),
						Nickname: row.card || row.nickname,
						Role: row.role
					};
				};
				if (action === "member.info") {
					const userId = numericId(p.userId);
					const member = project(await this.connection.call("get_group_member_info", {
						group_id: Number(target.id),
						user_id: Number(userId),
						no_cache: true
					}));
					if (member.UserId !== userId) throw new OneBotError("protocol");
					data = member;
				} else {
					const cursor = p.Cursor ?? "0";
					if (typeof cursor !== "string" || !/^(0|[1-9][0-9]{0,6})$/u.test(cursor)) throw new OneBotError("protocol");
					const offset = Number(cursor);
					const limit = p.Limit ?? 100;
					if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OneBotError("protocol");
					const rows = await this.connection.call("get_group_member_list", { group_id: Number(target.id) });
					if (!Array.isArray(rows)) throw new OneBotError("protocol");
					const end = Math.min(offset + limit, rows.length);
					data = {
						Items: rows.slice(offset, end).map(project),
						HasMore: end < rows.length,
						...end < rows.length ? { NextCursor: String(end) } : {}
					};
				}
			} else if (action === "mention.get") data = payload.event?.MessageMentions || [];
			else if (action === "connection.status") data = this.connection.status();
			else return [createResult(ResultCode.Fail, "此 OneBot 适配器不支持该操作。", null)];
			return [createResult(ResultCode.Ok, "操作已确认。", data)];
		} catch (error) {
			return [this.failure(error)];
		}
	}
	async api(frame) {
		try {
			const payload = frame.payload || {};
			const event = payload.event || {};
			if (event.Platform !== "onebot" || event.BotId && event.BotId !== this.connection.config.selfId) throw new Error("平台身份不匹配。");
			const [args = {}] = payload.params || [];
			let data;
			if (payload.key === "agentLink.sendSticker") {
				const encoded = args.data;
				const replyId = validMessageId(args.replyId);
				if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(20971520 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("表情图片编码无效或过大。");
				data = await this.send(payload, [...replyId ? [{
					type: "reply",
					data: { id: replyId }
				}] : [], {
					type: "image",
					data: {
						file: `base64://${encoded}`,
						sub_type: 1,
						summary: "[表情]"
					}
				}]);
			} else if (payload.key === "agentLink.stickerFavorites") {
				if (!event.IsMaster) throw new Error("只有主人能读取 QQ 收藏表情。");
				const count = args.count;
				if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw new Error("收藏表情数量无效。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				const result = await this.connection.call("fetch_custom_face", { count });
				data = { urls: (Array.isArray(result) ? result : result && typeof result === "object" && "data" in result && Array.isArray(result.data) ? result.data : []).map((row) => {
					if (typeof row === "string") return row;
					if (row && typeof row === "object" && "url" in row && typeof row.url === "string") return row.url;
					return "";
				}).filter((url) => url.length > 0 && url.length <= 2048 && /^https:\/\//u.test(url) && !/[\0\r\n]/u.test(url)) };
			} else if (payload.key === "agentLink.stickerFavoriteAdd") {
				if (!event.IsMaster) throw new Error("只有主人能写入 QQ 收藏表情。");
				const encoded = args.data;
				const name = args.name;
				if (typeof encoded !== "string" || !encoded || encoded.length > Math.ceil(20971520 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error("收藏表情图片编码无效或过大。");
				if (name !== void 0 && (typeof name !== "string" || !name.trim() || name.trim().length > 20)) throw new Error("收藏表情名称无效。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				const result = await this.connection.call("add_custom_face", { file: `base64://${encoded}` });
				const nested = typeof result === "object" ? result?.data : void 0;
				const rawId = typeof result === "string" ? result : [
					result?.emoji_id,
					result?.emojiId,
					result?.id,
					nested?.emoji_id,
					nested?.emojiId,
					nested?.id
				].find((value) => typeof value === "string" || typeof value === "number")?.toString() ?? "";
				const emojiId = /^[A-Za-z0-9_-]{1,64}$/u.test(rawId) ? rawId : "";
				if (!emojiId) throw new OneBotError("protocol");
				data = { emojiId };
			} else if (payload.key === "agentLink.stickerFavoriteRename") {
				if (!event.IsMaster) throw new Error("只有主人能修改 QQ 收藏表情。");
				const emojiId = args.emojiId;
				const name = args.name;
				if (typeof emojiId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId) || typeof name !== "string" || !name.trim() || name.trim().length > 20) throw new Error("收藏表情标识或名称无效。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				await this.connection.call("modify_custom_face", {
					emoji_id: emojiId,
					desc: name.trim()
				});
				data = { emojiId };
			} else if (payload.key === "agentLink.stickerFavoriteDelete") {
				if (!event.IsMaster) throw new Error("只有主人能删除 QQ 收藏表情。");
				const emojiId = args.emojiId;
				if (typeof emojiId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(emojiId)) throw new Error("收藏表情标识无效。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				await this.connection.call("delete_custom_face", { emoji_id: emojiId });
				data = { emojiId };
			} else if (payload.key === "agentLink.capabilities") data = {
				...this.connection.status(),
				botId: this.connection.config.selfId,
				capabilities: [
					"message",
					"media",
					"poke",
					"group-role",
					"group-info",
					"member-info",
					"member-list",
					"group-admin",
					"message-read"
				]
			};
			else if (payload.key === "agentLink.readCurrentForward") {
				const id = args.id;
				if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/u.test(id) || !Array.isArray(event._ForwardIds) || !event._ForwardIds.slice(0, 3).includes(id)) throw new Error("转发标识不属于当前消息。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				const result = await this.connection.call("get_forward_msg", { id });
				if (!Array.isArray(result?.messages)) throw new OneBotError("protocol");
				let remaining = 6e3;
				const rows = [];
				for (const node of result.messages.slice(0, 24)) {
					if (!node || typeof node !== "object" || remaining <= 0) break;
					const row = node;
					const sender = String(row.sender?.card || row.sender?.nickname || row.sender?.user_id || row.user_id || "未知发言人").slice(0, 80);
					let segments;
					try {
						segments = parseSegments(row.message ?? row.content ?? []);
					} catch {
						continue;
					}
					const text = segments.filter((segment) => segment.type === "text").map((segment) => String(segment.data.text || "")).join("").slice(0, Math.min(1e3, remaining));
					const attachments = segments.filter((segment) => [
						"image",
						"mface",
						"record",
						"video",
						"forward"
					].includes(segment.type)).slice(0, 3).map((segment) => segment.type);
					if (text || attachments.length) {
						rows.push({
							sender,
							text: isPersonalKeyCommand(text) ? "[个人密钥管理消息已隐藏]" : text.replace(/sk-[A-Za-z0-9_-]{8,240}/gu, "[密钥已隐藏]"),
							attachments
						});
						remaining -= text.length;
					}
				}
				data = { rows };
			} else if (payload.key === "agentLink.resolveQuotedImage") {
				const id = validMessageId(event.MessageContent?.replyReferenceId || event.ReplyId);
				if (!id || !Number.isSafeInteger(args.index) || args.index < 0 || args.index >= 5) throw new Error("引用图片标识无效。");
				const quote = await this.api({ payload: {
					event,
					key: "agentLink.readCurrentQuote",
					params: [{ messageId: id }]
				} });
				if (quote.length !== 1 || quote[0].code !== ResultCode.Ok || !Array.isArray(quote[0].data?.attachments) || typeof args.file !== "string" || quote[0].data.attachments[args.index]?._onebotImageFile !== args.file) throw new OneBotError("protocol");
				return await this.api({ payload: {
					event: {
						...event,
						MessageId: id,
						MessageMedia: quote[0].data.attachments
					},
					key: "agentLink.resolveCurrentImage",
					params: [{ index: args.index }]
				} });
			} else if (payload.key === "agentLink.resolveCurrentImage") {
				const index = args.index;
				const media = event.MessageMedia;
				const item = Array.isArray(media) && Number.isSafeInteger(index) && index >= 0 && index < Math.min(media.length, 5) ? media[index] : void 0;
				const file = item?._onebotImageFile;
				if (!validMessageId(event.MessageId) || ![
					"image",
					"sticker",
					"animation"
				].includes(item?.Type) || typeof file !== "string" || !file || file.length > 2048 || /[\0\r\n]/u.test(file)) throw new Error("当前消息没有可获取的图片。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				const result = file.startsWith("base64://") ? { file } : await this.connection.call("get_image", { file });
				const encoded = typeof result?.base64 === "string" ? result.base64 : typeof result?.file === "string" && result.file.startsWith("base64://") ? result.file.slice(9) : void 0;
				if (encoded !== void 0) {
					if (encoded.length > Math.ceil(41943040 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new OneBotError("protocol");
					const bytes = Buffer.from(encoded, "base64");
					if (!bytes.length || bytes.length > 10485760 || !imageMime(bytes)) throw new OneBotError("protocol");
					data = { base64: encoded };
				} else if (typeof result?.file === "string" && !/^https?:\/\//iu.test(result.file)) try {
					data = { base64: (await readImageFile(this.connection.config.imageDirectory, result.file)).toString("base64") };
				} catch (error) {
					if (typeof result.url !== "string" || result.url.length > 2048) throw error;
					data = { url: result.url };
				}
				else if (typeof (result?.url || result?.file) === "string" && String(result.url || result.file).length <= 2048) data = { url: result.url || result.file };
				else throw new OneBotError("protocol");
			} else if (payload.key === "agentLink.convertCurrentVoice") {
				const media = event.MessageMedia;
				const audio = Array.isArray(media) ? media.filter((item) => item?.Type === "audio") : [];
				const file = audio[0]?._onebotRecordFile;
				if (!validMessageId(event.MessageId) || audio.length !== 1 || typeof file !== "string" || !file || file.length > 2048 || /[\0\r\n]/u.test(file)) throw new Error("当前消息没有可转换的单条语音。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				const result = await this.connection.call("get_record", {
					file,
					out_format: "wav"
				});
				const encoded = typeof result?.base64 === "string" ? result.base64 : typeof result?.file === "string" && result.file.startsWith("base64://") ? result.file.slice(9) : void 0;
				if (typeof encoded === "string" && encoded.length <= Math.ceil(41943040 / 3) + 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
					const audio = Buffer.from(encoded, "base64");
					if (!audio.length || audio.length > 10485760 || audioFormat(audio)?.extension !== "wav") throw new OneBotError("protocol");
					data = { base64: encoded };
				} else if (encoded !== void 0) throw new OneBotError("protocol");
				else if (typeof result?.file === "string" && !/^https?:\/\//iu.test(result.file)) try {
					data = { base64: (await readRecordFile(this.connection.config.recordDirectory, result.file)).toString("base64") };
				} catch (error) {
					if (typeof result.url !== "string" || result.url.length > 2048) throw error;
					data = { url: result.url };
				}
				else if (typeof (result?.url || result?.file) === "string" && String(result.url || result.file).length <= 2048) data = { url: result.url || result.file };
				else throw new OneBotError("protocol");
			} else if (payload.key === "agentLink.transcribeCurrentVoice") {
				const id = validMessageId(event.MessageId);
				const media = event.MessageMedia;
				if (!id || !Array.isArray(media) || media.filter((item) => item?.Type === "audio").length !== 1 || media.some((item) => item?.Type === "audio" && item.Transcript?.trim())) throw new Error("当前消息不是可转写的单条语音。");
				numericId(event.UserId);
				if (!event.IsPrivate) numericId(event.ChannelId);
				const result = await this.connection.call("fetch_ptt_text", { message_id: Number(id) });
				if (typeof result?.text !== "string" || !result.text.trim() || result.text.length > 12e3) throw new OneBotError("protocol");
				data = { text: result.text.trim() };
			} else if (payload.key === "agentLink.poke") {
				if (this.policy().disabled.includes("platform")) throw new Error("平台表达模块已停用。");
				const userId = numericId(event.UserId);
				const groupId = event.IsPrivate ? void 0 : numericId(event.ChannelId);
				if (userId === this.connection.config.selfId) throw new Error("不能回戳自己。");
				await this.connection.call("send_poke", {
					user_id: Number(userId),
					...groupId ? { group_id: Number(groupId) } : {}
				});
				data = { ok: true };
			} else if (payload.key === "agentLink.groupRole") {
				const groupId = numericId(args.groupId || event.ChannelId);
				if (event.IsPrivate && !this.policy().owner(event.UserId) || !event.IsPrivate && groupId !== event.ChannelId) throw new Error("不允许跨会话查询。");
				data = {
					groupId,
					role: (await this.member(groupId, this.connection.config.selfId)).role
				};
			} else if (payload.key === "agentLink.manageGroup") data = await this.manage(event, args);
			else if ([
				"agentLink.qzoneRead",
				"agentLink.qzonePost",
				"agentLink.qzoneDetail",
				"agentLink.qzoneInteract"
			].includes(payload.key)) {
				const policy = this.policy();
				const settings = policy.qzone || {};
				if (!event.IsPrivate || !policy.owner(event.UserId) || policy.disabled.includes("qzone") || settings.enabled !== true) throw new Error("当前会话没有 QQ 空间授权。");
				if (payload.key === "agentLink.qzoneRead") {
					const kind = args.kind;
					if (!["own", "feed"].includes(kind)) throw new Error("空间读取类型无效。");
					const result = await this.connection.call(kind === "own" ? "get_qzone_msg_list" : "get_qzone_feeds", kind === "own" ? { num: 10 } : { count: 10 });
					const rows = kind === "own" ? result?.msglist : result?.feeds;
					if (!Array.isArray(rows)) throw new OneBotError("protocol");
					data = { items: rows.slice(0, 10).map((row) => ({
						id: String(kind === "own" ? row?.tid || "" : row?.key || "").slice(0, 200),
						author: String(row?.nickname || row?.name || "").slice(0, 100),
						authorId: kind === "own" ? this.connection.config.selfId : (() => {
							try {
								return numericId(row?.uin);
							} catch {
								return null;
							}
						})(),
						interactable: kind === "own" || Number(row?.appid) === 311,
						content: String(kind === "own" ? row?.content || "" : row?.html || "").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").slice(0, 1e3),
						time: Number.isSafeInteger(Number(row?.time)) && Number(row.time) > 0 ? Number(row.time) : null
					})) };
				} else if (payload.key === "agentLink.qzonePost") {
					if (settings.allowPost !== true || settings.dryRun !== false) throw new Error("空间发布未启用。");
					const rights = {
						all: 1,
						friends: 4,
						self: 64
					};
					if (typeof args.content !== "string" || !args.content.trim() || Array.from(args.content).length > 2e3 || !Object.hasOwn(rights, args.visibility)) throw new Error("空间内容或可见范围无效。");
					const images = args.images ?? [];
					if (!Array.isArray(images) || images.length > 4 || images.some((image) => typeof image !== "string" || image.length > Math.ceil(33554432 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image)) || images.reduce((sum, image) => sum + image.length, 0) > 29360128) throw new Error("空间图片编码或大小无效。");
					for (const image of images) {
						const data = Buffer.from(image, "base64");
						if (data.length > 8388608 || !imageMime(data)) throw new Error("空间图片格式或大小无效。");
					}
					const result = await this.connection.call("send_qzone_msg", {
						content: args.content.trim(),
						ugc_right: rights[args.visibility],
						...images.length ? { images: images.map((image) => `base64://${image}`) } : {}
					});
					const id = String(result?.tid ?? result?.id ?? (typeof result === "string" ? result : ""));
					if (!id || id.length > 200) throw new OneBotError("protocol");
					data = { id };
				} else {
					if (typeof args.id !== "string" || !args.id.trim() || args.id.length > 200 || [...args.id].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127)) throw new Error("空间动态编号无效。");
					const target = numericId(args.authorId);
					const params = {
						tid: args.id,
						...target === this.connection.config.selfId ? {} : { target_uin: Number(target) }
					};
					if (payload.key === "agentLink.qzoneDetail") {
						const result = await this.connection.call("get_qzone_msg_detail", {
							...params,
							num: 30
						});
						if (!result || typeof result !== "object" || !Array.isArray(result.comments)) throw new OneBotError("protocol");
						data = {
							content: String(result.content || "").slice(0, 2e3),
							comments: result.comments.slice(0, 30).map((row) => ({
								id: String(row?.comment_id || "").slice(0, 200),
								author: String(row?.name || "").slice(0, 100),
								content: String(row?.content || "").slice(0, 500),
								replies: (Array.isArray(row?.replies) ? row.replies : []).slice(0, 10).map((reply) => ({
									author: String(reply?.name || "").slice(0, 100),
									content: String(reply?.content || "").slice(0, 500)
								}))
							}))
						};
					} else {
						if (settings.allowInteract !== true || settings.dryRun !== false) throw new Error("空间互动未启用。");
						if (args.action === "comment") {
							if (typeof args.content !== "string" || !args.content.trim() || Array.from(args.content).length > 500) throw new Error("评论内容无效。");
							await this.connection.call("comment_qzone", {
								...params,
								content: args.content.trim()
							});
						} else if (args.action === "like") {
							if (!Number.isSafeInteger(args.time) || args.time <= 0) throw new Error("空间动态时间无效。");
							await this.connection.call("like_qzone", {
								...params,
								abstime: args.time
							});
						} else throw new Error("空间互动类型无效。");
						data = { ok: true };
					}
				}
			} else if (payload.key === "agentLink.readCurrentQuote") {
				const id = validMessageId(event.MessageContent?.replyReferenceId || event.ReplyId);
				if (!id || id !== validMessageId(args.messageId)) throw new Error("引用编号不属于当前消息。");
				const currentUser = numericId(event.UserId);
				const message = await this.connection.call("get_msg", { message_id: Number(id) });
				if (!message || message.message_id !== void 0 && validMessageId(message.message_id) !== id) throw new OneBotError("protocol");
				const sender = numericId(message.sender?.user_id ?? message.user_id);
				if (event.IsPrivate) {
					const target = message.target_id ?? message.peer_id;
					const incoming = sender === currentUser && (target === void 0 || String(target) === this.connection.config.selfId);
					const outgoing = sender === this.connection.config.selfId && (target === void 0 ? String(message.user_id ?? "") === currentUser : String(target) === currentUser);
					if (message.message_type !== "private" || !incoming && !outgoing) throw new Error("这条消息不属于当前私聊。");
				} else if (String(message.group_id) !== numericId(event.ChannelId) || message.message_type && message.message_type !== "group") throw new Error("这条消息不属于当前群聊。");
				const segments = parseSegments(message.message);
				const rawText = segments.filter((item) => item.type === "text").map((item) => String(item.data.text || "")).join("").slice(0, 3e3);
				const attachments = segments.filter((item) => [
					"image",
					"mface",
					"record",
					"video"
				].includes(item.type)).slice(0, 8).map((item) => ({
					Type: item.type === "record" ? "audio" : item.type === "video" ? "video" : item.type === "mface" ? "sticker" : "image",
					...typeof item.data.url === "string" && item.data.url.length <= 2048 ? { Url: item.data.url } : {},
					...["image", "mface"].includes(item.type) && typeof item.data.file === "string" && item.data.file.length <= 2048 && !/[\0\r\n]/u.test(item.data.file) ? { _onebotImageFile: item.data.file } : {}
				}));
				data = {
					id,
					referenceId: id,
					userId: sender,
					userName: String(message.sender?.card || message.sender?.nickname || sender).slice(0, 80),
					text: isPersonalKeyCommand(rawText) ? "[个人密钥管理消息已隐藏]" : rawText.replace(/sk-[A-Za-z0-9_-]{8,240}/gu, "[密钥已隐藏]"),
					timestamp: Number.isFinite(message.time) && message.time >= 0 && message.time <= 864e10 ? message.time * 1e3 : null,
					isBot: sender === this.connection.config.selfId,
					attachments
				};
			} else if (payload.key === "agentLink.readMessage") {
				const id = validMessageId(args.messageId);
				if (!id) throw new Error("消息编号无效。");
				const message = await this.connection.call("get_msg", { message_id: Number(id) });
				const groupId = event.IsPrivate ? void 0 : numericId(event.ChannelId);
				if (groupId ? String(message.group_id) !== groupId : message.message_type !== "private" || ![message.user_id, message.sender?.user_id].some((user) => String(user) === String(event.UserId))) throw new Error("这条消息不属于当前会话。");
				data = {
					messageId: id,
					text: parseSegments(message.message).filter((item) => item.type === "text").map((item) => item.data.text).join("").slice(0, 6e3)
				};
			} else throw new Error("未开放这个平台接口。");
			return [createResult(ResultCode.Ok, "操作已确认。", data)];
		} catch (error) {
			return [this.failure(error)];
		}
	}
	failure(error) {
		return createResult(ResultCode.Fail, error instanceof OneBotError ? error.message : "平台操作未通过校验或未确认完成。", {
			kind: error instanceof OneBotError ? error.kind : "validation",
			...error instanceof OneBotError && error.retcode !== void 0 ? { retcode: error.retcode } : {}
		});
	}
	async member(groupId, userId) {
		const result = await this.connection.call("get_group_member_info", {
			group_id: Number(groupId),
			user_id: Number(userId),
			no_cache: true
		});
		if (String(result?.group_id) !== groupId || String(result?.user_id) !== userId || ![
			"owner",
			"admin",
			"member"
		].includes(result.role)) throw new Error("无法核实成员身份。");
		return { role: result.role };
	}
	async manage(event, args) {
		const policy = this.policy();
		if (!policy.owner(event.UserId) || policy.disabled.includes("group-admin")) throw new Error("当前发言人没有群管理授权。");
		const groupId = numericId(args.groupId || event.ChannelId);
		if (!policy.groups.includes(groupId) || !event.IsPrivate && groupId !== event.ChannelId) throw new Error("此群未授权管理。");
		const actor = await this.member(groupId, this.connection.config.selfId);
		if (!["owner", "admin"].includes(actor.role)) throw new Error("机器人没有管理权限。");
		const target = args.action !== "notice" ? numericId(args.userId) : void 0;
		const member = target ? await this.member(groupId, target) : void 0;
		if (["mute", "kick"].includes(args.action) && (target === this.connection.config.selfId || policy.owner(target) || member.role === "owner" || actor.role === "admin" && member.role === "admin")) throw new Error("目标身份受到保护。");
		const params = {
			group_id: Number(groupId),
			...target ? { user_id: Number(target) } : {}
		};
		if (args.action === "mute" || args.action === "unmute") {
			if (args.action === "mute" && (!Number.isSafeInteger(args.seconds) || args.seconds < 1 || args.seconds > 2592e3)) throw new Error("禁言时间无效。");
			await this.connection.call("set_group_ban", {
				...params,
				duration: args.action === "unmute" ? 0 : args.seconds
			});
		} else if (args.action === "kick") await this.connection.call("set_group_kick", {
			...params,
			reject_add_request: false
		});
		else if (args.action === "title") {
			if (actor.role !== "owner" || typeof args.text !== "string" || args.text.length > 24) throw new Error("修改头衔需要群主身份及有效内容。");
			await this.connection.call("set_group_special_title", {
				...params,
				special_title: args.text,
				duration: -1
			});
		} else if (args.action === "notice") {
			if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 2e3) throw new Error("公告内容无效。");
			await this.connection.call("_send_group_notice", {
				...params,
				content: args.text
			});
		} else throw new Error("群管理操作无效。");
		return {
			ok: true,
			groupId,
			action: args.action
		};
	}
};

export { OneBotActions, formatSegments };