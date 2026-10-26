import { numericId } from "./config.js";
import { OneBotError } from "./connection.js";
import { parseSegments, validMessageId } from "./events.js";
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
			if (payload.key === "agentLink.capabilities") data = {
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
			else if (payload.key === "agentLink.poke") {
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
			else if (payload.key === "agentLink.readMessage") {
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