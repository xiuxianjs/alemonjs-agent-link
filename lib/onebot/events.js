import { numericId } from "./config.js";
import { createUserHashKey } from "alemonjs";
import { createHash } from "node:crypto";

// src/onebot/events.ts
const unescape = (text) => text.replace(/&#44;/gu, ",").replace(/&#91;/gu, "[").replace(/&#93;/gu, "]").replace(/&amp;/gu, "&");
const parseSegments = (value) => {
	if (Array.isArray(value)) {
		if (value.length > 200 || value.some((item) => !item || typeof item.type !== "string" || !item.data || typeof item.data !== "object" || Array.isArray(item.data))) throw new Error("消息段无效。");
		return value;
	}
	if (typeof value !== "string" || value.length > 1e5) throw new Error("消息正文无效。");
	const segments = [];
	let cursor = 0;
	for (const match of value.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gu)) {
		if (match.index > cursor) segments.push({
			type: "text",
			data: { text: unescape(value.slice(cursor, match.index)) }
		});
		const data = Object.create(null);
		for (const field of match[2].split(",").slice(1)) {
			const split = field.indexOf("=");
			if (split > 0) data[field.slice(0, split)] = unescape(field.slice(split + 1));
		}
		segments.push({
			type: match[1],
			data
		});
		cursor = match.index + match[0].length;
		if (segments.length > 200) throw new Error("消息段过多。");
	}
	if (cursor < value.length) segments.push({
		type: "text",
		data: { text: unescape(value.slice(cursor)) }
	});
	return segments;
};
const validMessageId = (value) => {
	const id = String(value ?? "");
	return /^-?\d{1,16}$/u.test(id) && Number.isSafeInteger(Number(id)) ? id : void 0;
};
const normalizeOneBotEvent = (raw, selfId, owner) => {
	if (String(raw.self_id) !== selfId || !["message", "notice"].includes(raw.post_type)) return;
	const notice = raw.post_type === "notice";
	const poke = notice && raw.notice_type === "notify" && raw.sub_type === "poke";
	const noticeName = {
		group_recall: "message.delete",
		friend_recall: "private.message.delete",
		group_increase: "member.add",
		group_decrease: "member.remove",
		group_ban: raw.duration === 0 ? "member.unban" : "member.ban",
		group_admin: "member.update",
		group_card: "member.update"
	}[raw.notice_type];
	if (notice && !poke && !noticeName) return;
	const groupId = raw.group_id ? numericId(raw.group_id) : void 0;
	const userId = numericId(poke && !groupId ? raw.sender_id ?? raw.user_id : raw.user_id);
	if (!notice && !["group", "private"].includes(raw.message_type)) return;
	if (!notice && raw.message_type === "group" !== Boolean(groupId)) return;
	if (notice && !poke && (raw.notice_type === "friend_recall" ? Boolean(groupId) || userId === selfId : !groupId)) return;
	const privateChat = !groupId;
	const eventId = notice ? createHash("sha256").update(JSON.stringify([
		raw.notice_type,
		raw.sub_type,
		raw.time,
		groupId,
		userId,
		raw.target_id,
		raw.message_id,
		raw.duration
	])).digest("hex") : validMessageId(raw.message_id);
	if (!eventId || poke && (!Number.isFinite(raw.time) || String(raw.target_id) !== selfId || userId === selfId)) return;
	const segments = notice ? [] : parseSegments(raw.message);
	const text = segments.map((item) => item.type === "text" ? String(item.data.text || "") : item.type === "at" ? `<@${item.data.qq}>` : "").join("");
	const role = [
		"member",
		"admin",
		"owner"
	].includes(raw.sender?.role) ? raw.sender.role : void 0;
	const media = segments.flatMap((item) => {
		if (![
			"image",
			"record",
			"video"
		].includes(item.type)) return [];
		return [{
			Type: item.type === "record" ? "audio" : item.type === "video" ? "video" : "image",
			Url: typeof item.data.url === "string" ? item.data.url : void 0
		}];
	});
	const reply = segments.find((item) => item.type === "reply");
	const forwards = segments.filter((item) => item.type === "forward").map((item) => String(item.data.id || "")).filter((id) => /^[a-zA-Z0-9_-]{1,200}$/u.test(id)).slice(0, 3);
	return {
		name: notice && !poke ? noticeName : poke ? privateChat ? "private.notice.create" : "notice.create" : privateChat ? "private.message.create" : "message.create",
		Platform: "onebot",
		BotId: selfId,
		value: raw,
		IsPrivate: privateChat,
		IsBot: userId === selfId,
		Target: {
			scope: privateChat ? "c2c" : "group",
			targetId: groupId || userId,
			BotId: selfId
		},
		...groupId ? {
			ChannelId: groupId,
			GuildId: groupId,
			SpaceId: `GROUP:${groupId}`
		} : {},
		UserId: userId,
		UserKey: createUserHashKey({
			Platform: "onebot",
			UserId: userId
		}),
		UserName: String(raw.sender?.card || raw.sender?.nickname || userId).slice(0, 80),
		IsMaster: owner(userId),
		IsAdmin: role === void 0 ? void 0 : !privateChat && role !== "member",
		Role: role,
		MessageId: poke ? `poke:${eventId}` : notice ? validMessageId(raw.message_id) : eventId,
		EventId: notice ? `notice:${eventId}` : void 0,
		MessageText: poke ? "[戳了戳你]" : text,
		MessageMedia: media,
		MessageMentions: segments.filter((item) => item.type === "at" && /^[1-9]\d*$/u.test(String(item.data.qq))).map((item) => ({
			UserId: String(item.data.qq),
			UserKey: createUserHashKey({
				Platform: "onebot",
				UserId: String(item.data.qq)
			}),
			IsBot: String(item.data.qq) === selfId,
			IsMaster: owner(String(item.data.qq))
		})),
		MessageMentionEveryone: segments.some((item) => item.type === "at" && item.data.qq === "all"),
		PlatformAction: notice ? normalizeNoticeAction(raw, userId, selfId) : void 0,
		IsAtMe: segments.some((item) => item.type === "at" && String(item.data.qq) === selfId),
		ReplyId: reply ? validMessageId(reply.data.id) : void 0,
		_ForwardIds: forwards,
		...poke ? { _Poke: {
			actorId: userId,
			targetId: selfId
		} } : {},
		OccurredAt: Number.isFinite(raw.time) ? raw.time * 1e3 : void 0
	};
};
const normalizeNoticeAction = (raw, userId, selfId) => {
	const common = {
		actorId: /^[1-9]\d*$/u.test(String(raw.operator_id)) ? String(raw.operator_id) : void 0,
		subjectId: userId
	};
	switch (raw.notice_type) {
		case "notify": return raw.sub_type === "poke" ? {
			kind: "poke",
			actorId: userId,
			subjectId: selfId
		} : void 0;
		case "group_recall": return {
			...common,
			kind: "recall"
		};
		case "friend_recall": return {
			kind: "recall",
			actorId: userId,
			subjectId: userId
		};
		case "group_increase": return {
			...common,
			kind: "member_join"
		};
		case "group_decrease": return {
			...common,
			kind: ["kick", "kick_me"].includes(raw.sub_type) ? "member_kick" : "member_leave"
		};
		case "group_ban": return {
			...common,
			kind: raw.duration === 0 ? "unban" : "ban",
			durationSeconds: Number.isFinite(raw.duration) ? raw.duration : void 0
		};
		case "group_admin": return ["set", "unset"].includes(raw.sub_type) ? {
			...common,
			kind: `admin_${raw.sub_type}`
		} : void 0;
		case "group_card": return {
			...common,
			kind: "card_change",
			oldName: typeof raw.card_old === "string" ? raw.card_old.slice(0, 80) : void 0,
			newName: typeof raw.card_new === "string" ? raw.card_new.slice(0, 80) : void 0
		};
		default: return;
	}
};

export { normalizeOneBotEvent, parseSegments, validMessageId };