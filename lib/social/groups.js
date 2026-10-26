import { getGroupChatPolicy } from "./group-policy.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import "../dsh/client.js";
import { classifyGroupReply } from "./reply-gate.js";
import { GroupConversationCoordinator } from "./group-conversation.js";
import { moodGroupPolicy } from "../companion/expression.js";
import { logger } from "alemonjs";

// src/social/groups.ts
const scopedGroupPolicy = (channelId, platform = "") => {
	const config = getDSHConfig();
	return moodGroupPolicy(config, {
		channelId,
		platform
	}, getGroupChatPolicy(config.groupChat, channelId));
};
const processState = globalThis;
const groupConversations = processState.__agentLinkGroupConversations__ ??= new GroupConversationCoordinator({
	classify: classifyGroupReply,
	getPolicy: scopedGroupPolicy,
	onTiming: (timing) => logger.info(timing, "Group reply latency"),
	onError: () => logger.warn("AgentLink group conversation failed")
});

export { groupConversations, scopedGroupPolicy };