import { useMention } from "alemonjs";

// src/social/message-context.ts
const label = (value, max = 200) => typeof value === "string" && value ? value.slice(0, max) : null;
const flag = (value) => typeof value === "boolean" ? value : null;
const size = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const eventTime = (value) => {
	const time = size(value);
	return time !== null && time <= 864e13 ? new Date(time).toISOString() : null;
};
const describePlatformAction = (action) => {
	if (!action || ![
		"poke",
		"recall",
		"member_join",
		"member_leave",
		"member_kick",
		"ban",
		"unban",
		"admin_set",
		"admin_unset",
		"card_change"
	].includes(action.kind)) return null;
	return {
		kind: action.kind,
		actorId: label(action.actorId) ?? void 0,
		subjectId: label(action.subjectId) ?? void 0,
		durationSeconds: size(action.durationSeconds) ?? void 0,
		oldName: label(action.oldName, 80) ?? void 0,
		newName: label(action.newName, 80) ?? void 0
	};
};
const buildMessageContext = (event, mentions, trigger) => {
	const unique = [...new Map((mentions || []).filter((item) => typeof item.UserId === "string" && item.UserId).map((item) => [item.UserId, item])).values()];
	return {
		schemaVersion: 1,
		conversation: {
			platform: label(event.Platform),
			scope: event.IsPrivate ? "private" : label(event.Target?.scope) || (event.ChannelId ? "group_or_channel" : null),
			channelId: label(event.ChannelId),
			guildId: label(event.GuildId),
			botId: label(event.BotId)
		},
		sender: {
			id: label(event.UserId),
			name: label(event.UserName, 80),
			platformRole: label(event.Role, 40),
			isAdmin: flag(event.IsAdmin),
			isBot: flag(event.IsBot)
		},
		message: {
			id: label(event.MessageId),
			eventId: label(event.EventId),
			eventType: label(event.name),
			replyToId: label(event.MessageContent?.replyReferenceId || event.ReplyId)
		},
		time: {
			occurredAt: eventTime(event.OccurredAt),
			receivedAt: eventTime(event.CreateAt)
		},
		attachments: (event.MessageMedia || []).slice(0, 10).map((item, index) => ({
			index: index + 1,
			type: item.Type,
			name: label(item.FileName),
			mimeType: label(item.MimeType, 80),
			bytes: size(item.FileSize),
			width: size(item.Width),
			height: size(item.Height),
			transcript: label(item.Transcript, 200),
			contentStatus: item.Transcript ? "platform_transcript_available" : "metadata_only_content_not_yet_read"
		})),
		attachmentsTruncated: (event.MessageMedia?.length || 0) > 10,
		mentionEveryone: flag(event.MessageMentionEveryone),
		platformAction: describePlatformAction(event.PlatformAction),
		trigger,
		mentionsKnown: Array.isArray(mentions),
		mentionsTruncated: unique.length > 20,
		mentionedSelf: Boolean(event.IsAtMe || event.BotId && unique.some((item) => item.UserId === event.BotId)),
		mentions: unique.slice(0, 20).map((item) => ({
			id: item.UserId.slice(0, 200),
			name: item.UserName?.slice(0, 80) || null,
			isSelf: event.BotId ? item.UserId === event.BotId : null,
			isBot: typeof item.IsBot === "boolean" ? item.IsBot : null
		}))
	};
};
const readMessageContext = async (event, trigger) => {
	if (Array.isArray(event.MessageMentions)) return buildMessageContext(event, event.MessageMentions, trigger);
	try {
		const [mention] = useMention();
		const users = await mention.find();
		const bots = await mention.find({ IsBot: true });
		return buildMessageContext(event, Array.isArray(users.data) && Array.isArray(bots.data) ? [...users.data, ...bots.data] : void 0, trigger);
	} catch {
		return buildMessageContext(event, void 0, trigger);
	}
};

export { buildMessageContext, describePlatformAction, eventTime, readMessageContext };