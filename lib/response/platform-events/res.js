import { contextEvents, eventContexts, normalizeContextEvent } from "../../social/event-context.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getChatArchive, historyEnabled } from "../../history/store.js";
import { SessionRegistry } from "../../state/registry.js";
import "../../dsh/client.js";
import { getConversationId } from "../dsh/util.js";
import { groupConversations } from "../../social/groups.js";
import { messageReferences } from "../../social/references.js";
import { cancelGroupChat } from "../../dsh/orchestrator.js";
import { archiveIncoming } from "../../history/capture.js";
import { observeProactiveInput } from "../../proactive/observe.js";
import { runDSHChat } from "../dsh/chat.js";
import { claimPoke } from "../../social/poke.js";
import { submitGroupChat } from "../../social/respond.js";
import { logger, useEvent, useMedia, useMessage } from "alemonjs";

// src/response/platform-events/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: [...contextEvents] });
	try {
		if (!context.match.selects) return;
		const event = normalizeContextEvent(context.current);
		if (!eventContexts.record(event)) return;
		const config = getDSHConfig();
		if (["notice.create", "private.notice.create"].includes(event.name) && claimPoke(config, event)) {
			observeProactiveInput(config, event);
			const transport = {
				message: useMessage()[0],
				media: useMedia()[0]
			};
			const prompt = "当前发言人刚刚戳了戳你。请自然地回应，可以适度使用 poke_speaker 回戳，不要每次都回戳。";
			if (event.IsPrivate) await runDSHChat(event, prompt, {
				transport,
				userText: "[戳了戳你]"
			});
			else await submitGroupChat(event, prompt, transport);
		}
		if ([
			"message.update",
			"message.delete",
			"private.message.update",
			"private.message.delete"
		].includes(event.name)) {
			const channelId = getConversationId(event);
			if (channelId) {
				groupConversations.invalidateRecent(channelId);
				cancelGroupChat(channelId, false);
			}
			await messageReferences.invalidate(event);
			if (channelId && event.Platform && historyEnabled(config)) {
				const id = event.MessageContent?.referenceId || event.MessageId;
				if (id) getChatArchive(config).invalidate({
					platform: event.Platform,
					channelId
				}, id);
				if (event.name.endsWith(".update")) archiveIncoming(config, event);
			}
			if (channelId) await new SessionRegistry(getDSHConfig()).clearRecent(channelId).catch(() => logger.warn("Event recent-context cleanup failed"));
			if (event.name.endsWith(".update") && typeof event.MessageText === "string") await messageReferences.capture(event);
		}
	} catch {
		logger.warn("Platform event context processing failed");
	} finally {
		await Promise.resolve(next());
	}
};

export { res_default as default };