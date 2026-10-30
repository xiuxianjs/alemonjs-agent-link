import { boundKeyGroupPolicy } from "./group-policy.js";
import { withBudgetScope } from "../billing/budget.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { historyEnabled } from "../history/store.js";
import { getGroupWakeStore, groupWakeNamespace } from "./group-wake-store.js";
import { getBoundCredential } from "../credentials/scoped.js";
import "../dsh/client.js";
import { groupPolicy } from "./group-settings.js";
import { classifyGroupReply } from "./reply-gate.js";
import { GroupConversationCoordinator } from "./group-conversation.js";
import { moodGroupPolicy } from "../companion/expression.js";
import { getGroupWaitStore, groupWaitNamespace } from "./group-wait-store.js";
import { logger } from "alemonjs";

// src/social/groups.ts
const scopedGroupPolicy = (channelId, platform = "") => {
	const config = getDSHConfig();
	return moodGroupPolicy(config, {
		channelId,
		platform
	}, groupPolicy(config, channelId, platform));
};
/**
* 自带 Key 的群同时开放网页与文件工具；终端不在提权范围内，始终为 false。
* 不想让某个群走提权时，在 groupChat.overrides 里给该群设 boundKeyElevation: false。
*/
const isKeyEntitledGroup = async (scope) => {
	if (!scope.platform) return false;
	if (groupPolicy(getDSHConfig(), scope.channelId, scope.platform).boundKeyElevation === false) return false;
	try {
		const bound = await withBudgetScope({
			platform: scope.platform,
			channelId: scope.channelId,
			userId: scope.userId
		}, getBoundCredential);
		return Boolean(bound);
	} catch {
		return false;
	}
};
/** 自带 Key 的群是否放开网页与文件工具；终端永远为 false。 */
const entitledCapabilities = (capabilities, entitled, allowTools) => entitled && allowTools ? {
	...capabilities,
	web: true,
	files: true,
	terminal: false
} : capabilities;
const resolveGroupCapabilities = async (scope, capabilities) => {
	if (scope.private || capabilities.web && capabilities.files) return capabilities;
	const allowTools = groupPolicy(getDSHConfig(), scope.channelId, scope.platform).boundKeyTools !== false;
	return entitledCapabilities(capabilities, await isKeyEntitledGroup(scope), allowTools);
};
const processState = globalThis;
const groupConversations = processState.__agentLinkGroupConversations__ ??= new GroupConversationCoordinator({
	onInput: (message) => {
		const config = getDSHConfig();
		if (config.modules?.settings?.conversation?.wakeEnabled !== true) return;
		try {
			getGroupWakeStore(config).clear(groupWakeNamespace(config), message.channelId, {
				platform: message.platform || "",
				botId: message.botId ?? message.messageContext?.conversation?.botId ?? ""
			});
		} catch {
			logger.warn("Group wake input cancellation failed");
		}
	},
	waitNamespace: () => {
		const config = getDSHConfig();
		return JSON.stringify([groupWaitNamespace(config), historyEnabled(config)]);
	},
	waitPersistence: (scope) => {
		const config = getDSHConfig();
		const store = getGroupWaitStore(config);
		const savedScope = {
			...scope,
			namespace: groupWaitNamespace(config)
		};
		if (!historyEnabled(config)) {
			store.remove(savedScope);
			return;
		}
		return store.persistence(savedScope, () => logger.warn("Group wait persistence failed"));
	},
	clearPersistedWait: (channelId, scope, userKey) => {
		const config = getDSHConfig();
		const wait = getGroupWaitStore(config).remove({
			namespace: groupWaitNamespace(config),
			channelId,
			...scope
		}, userKey);
		try {
			return getGroupWakeStore(config).clear(groupWakeNamespace(config), channelId, scope) || wait;
		} catch {
			logger.warn("Group wake cleanup failed");
			return wait;
		}
	},
	classify: classifyGroupReply,
	resolvePolicy: async (message, policy) => {
		if (!message.platform) return policy;
		try {
			return await withBudgetScope({
				platform: message.platform,
				channelId: message.channelId,
				userId: message.userId
			}, getBoundCredential) ? boundKeyGroupPolicy(policy) : policy;
		} catch {
			return policy;
		}
	},
	getPolicy: scopedGroupPolicy,
	onTiming: (timing) => logger.info(timing, "Group reply latency"),
	onError: () => logger.warn("AgentLink group conversation failed")
});

export { entitledCapabilities, groupConversations, isKeyEntitledGroup, resolveGroupCapabilities, scopedGroupPolicy };