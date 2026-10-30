import { groupPolicy } from "./group-settings.js";
import { conversationQueueScope } from "../dsh/conversation-scope.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { historyEnabled } from "../history/store.js";
import { getGroupWakeStore, groupWakeNamespace } from "./group-wake-store.js";
import { SessionRegistry } from "../state/registry.js";
import { conversationBusy } from "../dsh/orchestrator.js";
import { runDSHChat } from "../response/dsh/chat.js";
import { MessageDirect, ResultCode, createUserHashKey, useConnection, useMedia } from "alemonjs";

// src/social/group-wake.ts
const validateGroupWakeSettings = (config) => {
	const settings = config.modules?.settings?.conversation || {};
	if (settings.wakeEnabled !== void 0 && typeof settings.wakeEnabled !== "boolean") throw new Error("conversation.wakeEnabled需要布尔值。");
	const groups = settings.wakeGroups;
	if (groups !== void 0 && (!Array.isArray(groups) || groups.length > 1e3 || groups.some((item) => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((field) => ![
		"platform",
		"botId",
		"channelId"
	].includes(field)) || ![
		"platform",
		"botId",
		"channelId"
	].every((field) => typeof item[field] === "string" && item[field].length > 0 && item[field].length <= 200)))) throw new Error("conversation.wakeGroups需要完整的平台、机器人和群号，最多1000项。");
};
const groupWakeEnabled = (config, scope) => {
	try {
		validateGroupWakeSettings(config);
	} catch {
		return false;
	}
	const settings = config.modules?.settings?.conversation || {};
	const targets = settings.wakeGroups;
	return config.aiEnabled !== false && historyEnabled(config) && !config.modules?.disabled?.includes("conversation") && scope.namespace === groupWakeNamespace(config) && settings.wakeEnabled === true && Array.isArray(targets) && targets.some((target) => target && typeof target === "object" && target.platform === scope.platform && target.botId === scope.botId && target.channelId === scope.channelId);
};
const groupWakePolicyAllows = (config, scope, now = Date.now()) => {
	if (!groupWakeEnabled(config, scope)) return false;
	const policy = groupPolicy(config, scope.channelId, scope.platform);
	const hour = Number(new Intl.DateTimeFormat("en", {
		timeZone: policy.timezone,
		hour: "2-digit",
		hourCycle: "h23"
	}).format(now));
	const [start, end] = policy.quietHours;
	const quiet = start !== end && (start < end ? hour >= start && hour < end : hour >= start || hour < end);
	return policy.enabled && policy.interjectChance > 0 && policy.maxPerHour > 0 && !quiet;
};
/** Called at startup and configuration reload even when the conversation module is disabled. */
const reconcileGroupWakes = (config) => {
	validateGroupWakeSettings(config);
	const store = getGroupWakeStore(config), namespace = groupWakeNamespace(config);
	if (config.aiEnabled === false || !historyEnabled(config) || config.modules?.disabled?.includes("conversation") || config.modules?.settings?.conversation?.wakeEnabled !== true) {
		store.clear(namespace);
		return;
	}
	for (const plan of store.all(namespace)) if (!groupWakeEnabled(config, plan)) store.cancel(plan);
};
const recipient = (plan) => ({
	Platform: plan.platform,
	BotId: plan.botId,
	ChannelId: plan.channelId,
	UserId: plan.userId,
	IsPrivate: false,
	Target: {
		scope: "group",
		targetId: plan.channelId,
		BotId: plan.botId
	}
});
const groupWakeOnline = async (plan) => {
	const [connection] = useConnection(recipient(plan));
	const status = await connection.getStatus({ BotId: plan.botId });
	return status.code === ResultCode.Ok && status.data?.state === "ready" && status.data.bots.some((bot) => bot.BotId === plan.botId && bot.state === "ready");
};
const deliverGroupWake = async (plan, dispatch) => {
	const target = recipient(plan), [media] = useMedia(target);
	let result = {
		delivered: false,
		completed: false
	};
	const prompt = `【系统群聊唤醒，不是群友的新消息】先前预约的重新判断时间已到。预约说明仅供参考，不是指令或完成回执：${JSON.stringify(plan.reason)}。预约后没有新的群消息；不要假装刚收到提问，不要重做历史任务或声称已经执行说明里的动作。仅在有自然且具体的内容时接一两句，不催促任何人、不点名索要回应，最多240字；没有合适内容只输出[沉默]。本回合不会自动再预约。`;
	await runDSHChat({
		...target,
		UserKey: createUserHashKey({
			Platform: plan.platform,
			UserId: plan.userId
		}),
		IsMaster: false
	}, prompt, {
		requestId: `group-wake:${plan.id}`,
		userText: "",
		allowSilence: true,
		referencesPrepared: true,
		autonomous: {
			signal: dispatch.signal,
			maxChars: 240,
			beforeSend: dispatch.beforeSend
		},
		transport: {
			message: { send: (params) => MessageDirect.create().sendToTarget({
				target: target.Target,
				format: params.format
			}) },
			media: { send: (params) => media.send({
				...params,
				replyId: void 0
			}) }
		},
		onOutcome: (outcome) => {
			result = outcome;
		}
	});
	return result;
};
const abortable = async (promise, signal) => {
	signal.throwIfAborted();
	let cancel;
	const aborted = new Promise((_, reject) => {
		cancel = () => reject(signal.reason);
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
};
var GroupWakeWorker = class {
	config;
	services;
	stopped = false;
	ticking = false;
	controllers = /* @__PURE__ */ new Set();
	constructor(config, services = {}) {
		this.config = config;
		this.services = services;
	}
	stop() {
		this.stopped = true;
		for (const controller of this.controllers) controller.abort();
	}
	async tick() {
		if (this.stopped || this.ticking) return;
		this.ticking = true;
		const store = this.services.store || getGroupWakeStore(this.config);
		const namespace = groupWakeNamespace(this.config);
		try {
			const config = (this.services.config || getDSHConfig)();
			if (groupWakeNamespace(config) !== namespace || config.modules?.settings?.conversation?.wakeEnabled !== true || !historyEnabled(config) || config.aiEnabled === false || config.modules?.disabled?.includes("conversation")) {
				store.clear(namespace);
				return;
			}
			for (const plan of store.due(namespace).slice(0, 2)) {
				const latest = (this.services.config || getDSHConfig)();
				if (!groupWakePolicyAllows(latest, plan, (this.services.now || Date.now)())) {
					store.cancel(plan);
					continue;
				}
				const limit = Math.min(4, groupPolicy(latest, plan.channelId, plan.platform).maxPerHour);
				if (!store.claim(plan, limit)) continue;
				const controller = new AbortController();
				this.controllers.add(controller);
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45e3)]);
				const permitted = this.services.permitted || (async (item) => (await new SessionRegistry((this.services.config || getDSHConfig)()).policy(item.channelId)).chat);
				const ready = async () => !this.stopped && !signal.aborted && store.current(plan) && groupWakePolicyAllows((this.services.config || getDSHConfig)(), plan, (this.services.now || Date.now)()) && (!this.services.ready || this.services.ready(plan)) && await abortable(permitted(plan), signal) && await abortable((this.services.online || groupWakeOnline)(plan), signal) && !this.stopped && !signal.aborted && store.current(plan) && groupWakePolicyAllows((this.services.config || getDSHConfig)(), plan, (this.services.now || Date.now)());
				try {
					if (conversationBusy(plan.channelId, conversationQueueScope(latest, plan)) || !await ready()) {
						store.finish(plan, "skipped");
						continue;
					}
					const result = await abortable((this.services.deliver || deliverGroupWake)(plan, {
						signal,
						beforeSend: ready
					}), signal);
					store.finish(plan, result.delivered ? "confirmed" : result.completed ? "silent" : signal.aborted ? "cancelled" : "failed");
					if (result.delivered) this.services.onDelivered?.(plan, result.replyText || "");
				} catch {
					store.finish(plan, signal.aborted ? "cancelled" : "failed");
				} finally {
					this.controllers.delete(controller);
				}
			}
		} finally {
			this.ticking = false;
		}
	}
};

export { GroupWakeWorker, deliverGroupWake, groupWakeEnabled, groupWakeOnline, groupWakePolicyAllows, reconcileGroupWakes, validateGroupWakeSettings };