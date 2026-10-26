import { ResultCode, useClient } from "alemonjs";

// src/platform/client.ts
var PlatformOperationError = class extends Error {
	kind;
	constructor(kind) {
		super("平台没有确认操作完成。");
		this.kind = kind;
	}
};
const platformClient = (context) => {
	if (context.platform !== "onebot") throw new PlatformOperationError("unsupported");
	const [client] = useClient({
		Platform: context.platform,
		BotId: context.botId,
		IsPrivate: context.private,
		UserId: context.userId,
		...context.private ? {} : {
			ChannelId: context.channelId,
			GuildId: context.channelId
		},
		Target: {
			scope: context.private ? "c2c" : "group",
			targetId: context.private ? context.userId : context.channelId,
			BotId: context.botId
		}
	});
	const checked = async (run) => {
		context.signal.throwIfAborted();
		const results = await run();
		if (!Array.isArray(results) || results.length !== 1 || results[0].code !== ResultCode.Ok) throw new PlatformOperationError(results?.[0]?.data?.kind || "unknown");
		context.signal.throwIfAborted();
		return results[0].data;
	};
	return {
		capabilities: () => checked(() => client.agentLink.capabilities()),
		role: (groupId) => checked(() => client.agentLink.groupRole({ groupId })),
		poke: () => checked(() => client.agentLink.poke()),
		manage: (operation) => checked(() => client.agentLink.manageGroup(operation))
	};
};

export { PlatformOperationError, platformClient };