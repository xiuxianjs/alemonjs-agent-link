import { isPersonalKeyCommand } from "../../credentials/personal.js";
import { getDSHConfig } from "../../dsh/runtime-config.js";
import "../../dsh/client.js";
import { messageReferences } from "../../social/references.js";
import { archiveIncoming } from "../../history/capture.js";
import { observeProactiveInput } from "../../proactive/observe.js";
import { logger, useEvent } from "alemonjs";

// src/response/history-capture/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: ["message.create", "private.message.create"] });
	try {
		if (context.match.selects && !isPersonalKeyCommand(context.current.MessageText)) {
			observeProactiveInput(getDSHConfig(), context.current);
			await messageReferences.capture(context.current).catch(() => logger.warn("Message reference capture failed"));
			archiveIncoming(getDSHConfig(), context.current);
		}
	} catch {
		logger.error("聊天历史采集失败，请检查归档配置。");
	}
	await Promise.resolve(next());
};

export { res_default as default };