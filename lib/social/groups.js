import { getGroupChatPolicy } from "./group-policy.js";
import { getDSHConfig } from "../dsh/client.js";
import { classifyGroupReply } from "./reply-gate.js";
import { GroupConversationCoordinator } from "./group-conversation.js";
import { logger } from "alemonjs";

// src/social/groups.ts
const processState = globalThis;
const groupConversations = processState.__agentLinkGroupConversations__ ??= new GroupConversationCoordinator({
	classify: classifyGroupReply,
	getPolicy: (channelId) => getGroupChatPolicy(getDSHConfig().groupChat, channelId),
	onTiming: (timing) => logger.info(timing, "Group reply latency"),
	onError: () => logger.warn("AgentLink group conversation failed")
});

export { groupConversations };