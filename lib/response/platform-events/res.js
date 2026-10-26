import { contextEvents, eventContexts, normalizeContextEvent } from "../../social/event-context.js";
import { SessionRegistry } from "../../state/registry.js";
import { getDSHConfig } from "../../dsh/client.js";
import { groupConversations } from "../../social/groups.js";
import { messageReferences } from "../../social/references.js";
import { getConversationId } from "../dsh/util.js";
import { cancelGroupChat } from "../../dsh/orchestrator.js";
import { logger, useEvent } from "alemonjs";

// src/response/platform-events/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: [...contextEvents] });
	try {
		if (!context.match.selects) return;
		const event = normalizeContextEvent(context.current);
		if (!eventContexts.record(event)) return;
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