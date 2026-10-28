import { proactiveOptions } from "./options.js";
import { getProactiveStore } from "./store.js";
import { logger } from "alemonjs";

// src/proactive/observe.ts
const scope = (event) => event.IsPrivate && event.IsMaster && !event.IsBot && event.Platform && event.BotId && event.UserId ? {
	platform: event.Platform,
	botId: event.BotId,
	userId: event.UserId
} : void 0;
const observeProactiveInput = (config, event) => {
	const recipient = scope(event);
	if (!recipient || !event.MessageId) return;
	try {
		const store = getProactiveStore(config);
		const options = proactiveOptions(config);
		if (options.autoSubscribe && !store.get(recipient)) store.subscribe(recipient, true, options);
		if (!store.input(recipient, event.MessageId)) return;
		if (/^(?:请|先|以后|最近|你|麻烦你|拜托你){0,3}(?:别|不要|不用)(?:再)?主动(?:来)?(?:找|联系|打扰)我(?:了)?[。！!\s]*$/u.test(String(event.MessageText || "").trim())) store.subscribe(recipient, false, options);
	} catch {
		logger.warn("Proactive activity observation failed");
	}
};
const observeProactiveOutput = (config, event, text) => {
	const recipient = scope(event);
	if (!recipient || !event.MessageId) return;
	try {
		getProactiveStore(config).output(recipient, event.MessageId, text);
	} catch {
		logger.warn("Proactive reply observation failed");
	}
};

export { observeProactiveInput, observeProactiveOutput };