import { getDSHConfig } from "../../dsh/client.js";
import { recordRecentMessage } from "../../chat-context/store.js";
import { describeSpeaker, extractWakePrompt } from "../dsh/util.js";
import { logger, useEvent, useMention } from "alemonjs";

// src/response/chat-context/capture.ts
var capture_default = async () => {
	const [eventContext, next] = useEvent({ selects: "message.create" });
	if (!eventContext.match.selects) {
		await Promise.resolve(next());
		return;
	}
	const event = eventContext.current;
	const text = String(event.MessageText ?? "").trim();
	if (event.IsBot || !event.ChannelId || !text || text.startsWith("/")) {
		await Promise.resolve(next());
		return;
	}
	const [mention] = useMention();
	if (!(await mention.findOne({ IsBot: true })).data && !event.IsAtMe) try {
		const config = getDSHConfig();
		if (extractWakePrompt(text, config.groupWakeNames) === null) await recordRecentMessage(event.ChannelId, {
			id: event.MessageId,
			text: `${describeSpeaker(event)}: ${text}`
		}, {
			maxMessages: config.recentChatMaxMessages,
			windowSeconds: config.recentChatWindowSeconds,
			maxChars: config.recentChatMaxChars
		}, config);
	} catch (error) {
		logger.warn({ err: error }, "Recent chat context disabled by invalid configuration");
	}
	await Promise.resolve(next());
};

export { capture_default as default };