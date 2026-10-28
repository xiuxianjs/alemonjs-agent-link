import { resolveOneBotConfig } from "./config.js";
import { OneBotConnection } from "./connection.js";
import { normalizeOneBotEvent } from "./events.js";
import { OneBotActions } from "./actions.js";
import { cbpPlatform, definePlatform, getAppConfigValue, getConfigValue, isMaster, logger } from "alemonjs";

// src/onebot/index.ts
const startOneBot = () => {
	const options = resolveOneBotConfig(getConfigValue());
	const bridge = cbpPlatform();
	const connection = new OneBotConnection(options, {
		event: (raw) => {
			try {
				const event = normalizeOneBotEvent(raw, options.selfId, (id) => isMaster(id, "onebot"));
				if (event) bridge.send(event);
			} catch {
				logger.warn("OneBot inbound event rejected");
			}
		},
		ready: () => bridge.send({
			name: "connection.ready",
			Platform: "onebot",
			BotId: options.selfId,
			value: "",
			transport: "onebot-v11"
		})
	});
	const actions = new OneBotActions(connection, () => {
		const { modules } = getAppConfigValue();
		return {
			owner: (id) => isMaster(id, "onebot"),
			groups: Array.isArray(modules?.settings?.["group-admin"]?.groups) ? modules.settings["group-admin"].groups : [],
			disabled: modules?.disabled || [],
			qzone: modules?.settings?.qzone || {}
		};
	});
	bridge.onactions((frame, consume) => {
		actions.action(frame).then(consume);
	});
	bridge.onapis((frame, consume) => {
		actions.api(frame).then(consume);
	});
	connection.start();
	return { stop: () => connection.stop() };
};
var onebot_default = definePlatform({
	name: "onebot",
	main: startOneBot
});

export { onebot_default as default, startOneBot };