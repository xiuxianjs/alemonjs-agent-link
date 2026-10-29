import { getConversationId } from "../response/dsh/util.js";
import { getPlatformLedger } from "../platform/ledger.js";

// src/social/poke.ts
const claimPoke = (config, event) => {
	const poke = event.Poke || event._Poke;
	const channelId = getConversationId(event);
	if (config.modules?.disabled?.includes("platform") || event.Platform !== "onebot" || !event.BotId || !channelId || !event.EventId || poke?.targetId !== event.BotId || poke.actorId !== event.UserId || poke.actorId === event.BotId || event.IsBot || !Number.isFinite(event.OccurredAt) || Math.abs(Date.now() - event.OccurredAt) > 6e4) return false;
	return getPlatformLedger(config).claimCooldown(JSON.stringify([
		event.Platform,
		event.BotId,
		channelId,
		"poke-inbound"
	]), 20, channelId);
};

export { claimPoke };