import { createHash } from "node:crypto";

// src/dsh/conversation-scope.ts
const conversationQueueScope = (config, identity) => ({
	namespace: JSON.stringify([config.workspaceRoot, config.dshHomeRoot]),
	platform: identity.platform || "",
	botId: identity.botId || ""
});
const conversationQueueKey = (channelId, scope) => JSON.stringify([
	scope?.namespace || "",
	scope?.platform || "",
	scope?.botId || "",
	channelId
]);
const sessionBaseId = (channelId) => channelId.startsWith("private:") ? `dsh:qq:private:${channelId.slice(8)}` : `dsh:qq:group:${channelId}`;
const bridgeSessionHash = (sessionBase) => createHash("sha256").update(sessionBase).digest("hex");
const bridgeConversationIdentity = (channelId, scope) => ({
	groupKey: bridgeSessionHash(sessionBaseId(channelId)),
	scopeKey: createHash("sha256").update(conversationQueueKey(channelId, scope)).digest("hex")
});
const conversationDataNamespace = (config) => createHash("sha256").update(JSON.stringify([config.workspaceRoot, config.dshHomeRoot])).digest("hex");
const conversationDataKey = (scope, namespace) => createHash("sha256").update(JSON.stringify(namespace !== void 0 || scope.botId !== void 0 ? [
	"v2",
	namespace ?? "",
	scope.platform,
	scope.botId ?? "",
	scope.channelId
] : [scope.platform, scope.channelId])).digest("hex");

export { bridgeConversationIdentity, bridgeSessionHash, conversationDataKey, conversationDataNamespace, conversationQueueKey, conversationQueueScope, sessionBaseId };