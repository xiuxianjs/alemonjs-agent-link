import { getDSHConfig } from "../../dsh/runtime-config.js";
import { getInteractionStore, interactionScene, interactionSignal } from "../../companion/interaction.js";
import { isPersonalKeyCommand } from "../../credentials/personal.js";
import "../../dsh/client.js";
import { canPrivateChatWithKey, getConversationId } from "../dsh/util.js";
import { messageReferences } from "../../social/references.js";
import { archiveIncoming } from "../../history/capture.js";
import { observeProactiveInput } from "../../proactive/observe.js";
import { rememberRecentMedia } from "../../media/recent.js";
import { autoStickerCollector } from "../../media/sticker-auto.js";
import { observeGroupTopics } from "../../group-topics/observe.js";
import { ensureProactiveSubscription } from "../../proactive/auto.js";
import { logger, useEvent } from "alemonjs";

// src/response/history-capture/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: ["message.create", "private.message.create"] });
	try {
		if (context.match.selects && !isPersonalKeyCommand(context.current.MessageText)) {
			try {
				observeGroupTopics(getDSHConfig(), context.current);
			} catch {
				logger.warn("Group topic observation failed");
			}
			try {
				const config = getDSHConfig();
				const event = context.current;
				if (!event.IsBot && event.Platform && event.UserId && !config.modules?.disabled?.includes("interaction") && (interactionSignal(event.MessageText || "") !== "none" || interactionScene(event.MessageText || "") !== "none")) {
					const channelId = getConversationId(event);
					if (channelId) getInteractionStore(config).observe({
						platform: event.Platform,
						botId: event.BotId,
						channelId,
						userId: event.UserId
					}, event.MessageText || "", event.MessageId || "");
				}
			} catch {
				logger.warn("Interaction observation failed");
			}
			rememberRecentMedia(context.current);
			try {
				ensureProactiveSubscription(getDSHConfig(), context.current);
			} catch {
				logger.warn("Automatic proactive subscription failed");
			}
			try {
				autoStickerCollector.enqueue(context.current);
			} catch {
				logger.warn("Automatic sticker collection settings invalid");
			}
			observeProactiveInput(getDSHConfig(), context.current);
			await messageReferences.capture(context.current).catch(() => logger.warn("Message reference capture failed"));
			const config = getDSHConfig();
			archiveIncoming(config, context.current, context.current.IsPrivate && await canPrivateChatWithKey(context.current, config.privateChatAccess));
		}
	} catch {
		logger.error("聊天历史采集失败，请检查归档配置。");
	}
	await Promise.resolve(next());
};

export { res_default as default };