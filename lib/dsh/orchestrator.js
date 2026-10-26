import { DSHError } from "./errors.js";
import { withBudgetScope } from "../billing/budget.js";
import { getDSHConfig } from "./runtime-config.js";
import { SessionRegistry } from "../state/registry.js";
import { clearSession, purgeSessionData } from "./client.js";
import { buildMemoryContext } from "./memory.js";
import { runModuleTurn } from "../agent/turn.js";
import { groupConversations } from "../social/groups.js";
import { getSessionId } from "../response/dsh/util.js";
import { messageReferences } from "../social/references.js";
import { logger } from "alemonjs";

// src/dsh/orchestrator.ts
const queues = /* @__PURE__ */ new Map();
const groupResetTransitions = /* @__PURE__ */ new Map();
let activeRequests = 0;
const acquireRequestSlot = (limit) => {
	if (activeRequests >= limit) throw new DSHError("http", "Agent 服务繁忙，请稍后重试");
	activeRequests += 1;
	let released = false;
	return () => {
		if (!released) {
			released = true;
			activeRequests -= 1;
		}
	};
};
const getRequestCapacity = () => ({ active: activeRequests });
const conversationBusy = (channelId) => Boolean(queues.get(channelId)?.running || queues.get(channelId)?.jobs.length);
const enqueueChat = async (channelId, maxQueued, userId, run, onQueued, onStarted) => {
	const queue = queues.get(channelId) ?? {
		running: false,
		jobs: []
	};
	queues.set(channelId, queue);
	if (queue.running && queue.jobs.length >= maxQueued) throw new DSHError("http", "当前群请求排队已满");
	return await new Promise((resolve, reject) => {
		const ahead = (queue.running ? 1 : 0) + queue.jobs.length;
		const queuedNotice = ahead > 0 && onQueued ? onQueued(ahead).catch((error) => logger.warn({ err: error }, "Unable to send DSH queue notice")) : Promise.resolve();
		queue.jobs.push({
			userId,
			reject,
			run: async () => {
				const controller = new AbortController();
				queue.cancel = controller;
				queue.activeUserId = userId;
				try {
					await queuedNotice;
					if (onStarted) try {
						await onStarted(ahead > 0, controller.signal);
					} catch (error) {
						logger.warn({ err: error }, "Unable to send DSH start notice");
					}
					await run(controller.signal);
					resolve();
				} finally {
					queue.cancel = void 0;
					queue.activeUserId = void 0;
				}
			}
		});
		if (queue.running) return;
		queue.running = true;
		(async () => {
			while (queue.jobs.length) {
				const next = queue.jobs.shift();
				try {
					await next.run();
				} catch (error) {
					next.reject(error instanceof Error ? error : /* @__PURE__ */ new Error("queue failure"));
				}
			}
			queue.running = false;
			if (!queue.jobs.length) queues.delete(channelId);
		})();
	});
};
const cancelGroupChat = (channelId, clearPending = true) => {
	if (clearPending) {
		groupConversations.clear(channelId);
		messageReferences.clear(channelId).catch(() => logger.warn("Message reference cleanup failed"));
	}
	const queue = queues.get(channelId);
	queue?.cancel?.abort();
	while (queue?.jobs.length) queue.jobs.shift().reject(new DSHError("cancelled", "会话已重置"));
};
/**
* A missing isolation marker is not a user action item. Atomically perform
* the same destructive boundary as /new before the first post-upgrade turn.
*/
const resetGroupSession = async (channelId, config, updateMemory, clearPending = true) => {
	const pending = groupResetTransitions.get(channelId);
	if (pending !== void 0) {
		await pending;
		if (updateMemory) await resetGroupSession(channelId, config, updateMemory, clearPending);
		return;
	}
	const registry = new SessionRegistry(config);
	const transition = (async () => {
		await registry.ready();
		const resetting = await registry.beginReset(channelId);
		if (!resetting.operationId) throw new DSHError("migration", "会话重置状态无效");
		cancelGroupChat(channelId, clearPending);
		await clearSession(config, getSessionId(channelId));
		await updateMemory?.();
		await registry.clearRecent(channelId);
		await registry.clearPrivateHistory(channelId);
		if (!await registry.completeReset(channelId, resetting.operationId)) throw new DSHError("migration", "会话重置被其他操作接管");
		logger.info({ group: await registry.groupKey(channelId) }, "Reset isolated group session");
	})();
	groupResetTransitions.set(channelId, transition);
	try {
		await transition;
	} finally {
		groupResetTransitions.delete(channelId);
	}
};
/** Initialize old metadata behind the same serialized boundary as /new. */
const ensureIsolatedGroup = async (channelId, config) => {
	const pending = groupResetTransitions.get(channelId);
	if (pending !== void 0) await pending;
	const registry = new SessionRegistry(config);
	await registry.ready();
	const meta = await registry.meta(channelId);
	if (meta.isolated && !meta.transition) return;
	if (meta.transition === "purging") await purgeGroupSession(channelId, config);
	await resetGroupSession(channelId, config, void 0, false);
};
/** Mark deletion before touching the Bridge so a failed purge can be resumed safely. */
const purgeGroupSession = async (channelId, config) => {
	const pending = groupResetTransitions.get(channelId);
	if (pending !== void 0) await pending;
	const registry = new SessionRegistry(config);
	const transition = (async () => {
		await registry.ready();
		await registry.beginPurge(channelId);
		cancelGroupChat(channelId);
		await purgeSessionData(config, `dsh:qq:group:${channelId}`);
		await registry.purgeHash(await registry.groupKey(channelId));
	})();
	groupResetTransitions.set(channelId, transition);
	try {
		await transition;
	} finally {
		if (groupResetTransitions.get(channelId) === transition) groupResetTransitions.delete(channelId);
	}
};
const cancelChatForUser = (channelId, userId, privileged) => {
	const queue = queues.get(channelId);
	if (!queue) return "empty";
	if (queue.cancel && queue.activeUserId === userId) {
		queue.cancel.abort();
		return "cancelled-running";
	}
	for (let index = queue.jobs.length - 1; index >= 0; index -= 1) if (queue.jobs[index].userId === userId) {
		const [job] = queue.jobs.splice(index, 1);
		job.reject(new DSHError("cancelled", "群会话已取消"));
		return "cancelled-queued";
	}
	if (privileged && queue.cancel) {
		queue.cancel.abort();
		return "cancelled-running";
	}
	return queue.running || queue.jobs.length ? "forbidden" : "empty";
};
const runCoordinatedChatInner = async (event, message, onEvent, onQueued, onStarted, capabilityOverride, onCompleted, mediaTask) => {
	const config = getDSHConfig();
	const registry = new SessionRegistry(config);
	await registry.ready();
	await ensureIsolatedGroup(event.ChannelId, config);
	const capabilities = capabilityOverride ?? await registry.policy(event.ChannelId);
	if (!capabilities.chat) throw new DSHError("http", "当前群未开放 Agent 对话权限");
	const duplicate = await registry.deduplicate(event.ChannelId, event.MessageId);
	if (duplicate.duplicate) return {
		...duplicate,
		confirmDelivery: () => Promise.resolve(),
		release: () => Promise.resolve()
	};
	const release = async () => await registry.releaseDeduplication(event.ChannelId, event.MessageId, duplicate.requestId);
	try {
		if (!await registry.allowUser(event.ChannelId, event.UserKey || "unknown")) throw new DSHError("http", "请求过于频繁");
		const meta = await registry.touch(event.ChannelId);
		await enqueueChat(event.ChannelId, config.maxQueuedPerGroup, event.UserKey || "unknown", async (signal) => {
			signal = mediaTask?.signal ? AbortSignal.any([signal, mediaTask.signal]) : signal;
			signal.throwIfAborted();
			const startedAt = Date.now();
			const releaseRequestSlot = acquireRequestSlot(config.maxConcurrentRequests);
			try {
				const current = await registry.meta(event.ChannelId);
				if (current.generation !== meta.generation || !current.isolated || current.transition) throw new DSHError("cancelled", "会话已重置");
				if (mediaTask?.execute) await mediaTask.execute(signal);
				else {
					const memoryContext = event.ChannelId.startsWith("private:") ? buildMemoryContext(await registry.privateMemories(event.ChannelId)) : "";
					signal.throwIfAborted();
					await runModuleTurn({
						config,
						sessionId: `${getSessionId(event.ChannelId)}:v${meta.generation}`,
						input: mediaTask?.prepareMessage ? await mediaTask.prepareMessage(message, signal) : message,
						onEvent,
						streamContent: mediaTask?.streamContent,
						onImage: mediaTask?.onImage,
						onSpeech: mediaTask?.onSpeech,
						context: {
							requestId: duplicate.requestId,
							inputId: mediaTask?.inputId || event.MessageId || duplicate.requestId,
							addressed: mediaTask?.addressed,
							autonomous: mediaTask?.autonomous,
							channelId: event.ChannelId,
							userId: event.UserId || event.UserKey || "unknown",
							platform: event.Platform || "",
							botId: event.BotId,
							private: event.ChannelId.startsWith("private:"),
							owner: Boolean(event.IsMaster),
							userText: mediaTask?.userText ?? message,
							capabilities,
							signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)])
						},
						history: {
							channelId: event.ChannelId,
							generation: meta.generation,
							memoryContext,
							record: mediaTask?.recordHistory,
							render: mediaTask?.renderAnswer
						},
						onCompleted
					});
				}
				signal.throwIfAborted();
				await registry.touch(event.ChannelId, meta.generation);
			} catch (error) {
				logger.warn({
					requestId: duplicate.requestId,
					elapsedMs: Date.now() - startedAt,
					kind: error instanceof DSHError ? error.kind : "unexpected"
				}, "Agent turn failed");
				if (signal.aborted) throw new DSHError("cancelled", "请求已取消");
				throw error;
			} finally {
				releaseRequestSlot();
			}
		}, onQueued, onStarted);
	} catch (error) {
		await release().catch((releaseError) => logger.warn({ err: releaseError }, "Unable to release failed DSH request"));
		throw error;
	}
	logger.info({
		requestId: duplicate.requestId,
		group: await registry.groupKey(event.ChannelId),
		status: "model_completed"
	}, "DSH chat completed");
	return {
		...duplicate,
		confirmDelivery: async () => {
			if (!await registry.finalizeDeduplication(event.ChannelId, event.MessageId, duplicate.requestId)) {
				logger.warn({
					requestId: duplicate.requestId,
					group: await registry.groupKey(event.ChannelId)
				}, "DSH response delivery confirmation lost its request claim");
				return;
			}
			logger.info({
				requestId: duplicate.requestId,
				group: await registry.groupKey(event.ChannelId),
				status: "delivered"
			}, "DSH response delivered");
		},
		release
	};
};
const runCoordinatedChat = (...args) => withBudgetScope({
	platform: args[0].Platform || "",
	channelId: args[0].ChannelId
}, () => runCoordinatedChatInner(...args));

export { cancelChatForUser, cancelGroupChat, conversationBusy, enqueueChat, ensureIsolatedGroup, getRequestCapacity, purgeGroupSession, resetGroupSession, runCoordinatedChat };