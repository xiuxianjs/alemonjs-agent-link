import { getDSHConfig } from "../dsh/runtime-config.js";
import { SessionRegistry } from "../state/registry.js";
import "../dsh/client.js";
import { buildGroupBatchPrompt } from "./group-conversation.js";
import { groupConversations, scopedGroupPolicy } from "./groups.js";
import { messageReferences } from "./references.js";
import { ensureIsolatedGroup } from "../dsh/orchestrator.js";
import { runDSHChat } from "../response/dsh/chat.js";
import { Format, logger } from "alemonjs";
import { randomUUID } from "node:crypto";

// src/social/respond.ts
const respondToGroupBatch = async (event, transport, batch) => {
	let result = {
		delivered: false,
		completed: false
	};
	const registry = new SessionRegistry(getDSHConfig());
	const claims = [];
	const accepted = [];
	try {
		await ensureIsolatedGroup(event.ChannelId, getDSHConfig());
		for (const message of batch.messages) {
			if (message.id) {
				const id = `group-message:${message.id}`;
				const claim = await registry.deduplicate(message.channelId, id);
				if (claim.duplicate) continue;
				claims.push({
					id,
					requestId: claim.requestId
				});
			}
			accepted.push(message);
		}
		const direct = accepted.filter((message) => message.direct || message.explicitCommand);
		const anchor = accepted.includes(batch.anchor) ? batch.anchor : batch.mode === "direct" ? direct.filter((message) => message.explicitCommand).at(-1) || direct.at(-1) : accepted.at(-1);
		if (!anchor || batch.mode === "direct" && !direct.length) result = {
			delivered: false,
			completed: true
		};
		else {
			const requestId = anchor === batch.anchor ? batch.id : `group-batch:${anchor.id || randomUUID()}`;
			const currentBatch = {
				...batch,
				id: requestId,
				messages: accepted,
				anchor
			};
			await runDSHChat({
				...event,
				UserId: anchor.userId,
				UserKey: anchor.userKey,
				UserName: anchor.name,
				IsMaster: anchor.owner,
				MessageId: anchor.id,
				MessageMedia: accepted.flatMap((item) => item.media || [])
			}, buildGroupBatchPrompt(currentBatch), {
				requestId,
				referencesPrepared: true,
				voice: anchor.voice,
				userText: anchor.text,
				allowSilence: batch.mode !== "direct",
				replyReferences: Object.fromEntries(accepted.flatMap((message, index) => message.id ? [[`m${index + 1}`, {
					messageId: message.id,
					userId: message.userId
				}]] : [])),
				transport,
				onOutcome: (outcome) => {
					result = outcome;
				}
			});
		}
		if (result.completed) for (const claim of claims) await registry.finalizeDeduplication(event.ChannelId, claim.id, claim.requestId).catch(() => logger.warn("Group source message confirmation failed"));
	} catch {
		logger.warn("Group batch preparation failed");
		if (batch.mode === "direct") await transport?.message.send({ format: Format.create().addText("群聊消息暂时无法处理，请稍后重试。") }).catch(() => logger.warn("Group preparation failure could not be reported"));
	} finally {
		if (!result.completed) for (const claim of claims) await registry.releaseDeduplication(event.ChannelId, claim.id, claim.requestId).catch(() => logger.warn("Group source message claim release failed"));
	}
	return result;
};
const submitGroupChat = async (event, prompt, transport, voice = false) => {
	if (!event.ChannelId || event.IsPrivate || event.IsBot) return;
	const references = event.ReplyId || event.MessageContent ? await messageReferences.prepare(event) : {
		media: event.MessageMedia,
		context: void 0
	};
	await groupConversations.receive({
		channelId: event.ChannelId,
		platform: event.Platform,
		id: event.MessageId,
		userId: event.UserId || "unknown",
		userKey: event.UserKey || event.UserId || "unknown",
		name: (event.UserName || "").slice(0, 80),
		owner: Boolean(event.IsMaster),
		text: prompt || "请结合引用消息回应。",
		referenceContext: references.context,
		direct: true,
		media: references.media,
		voice,
		explicitCommand: true
	}, scopedGroupPolicy(event.ChannelId, event.Platform), (batch) => respondToGroupBatch(event, transport, batch));
};

export { respondToGroupBatch, submitGroupChat };