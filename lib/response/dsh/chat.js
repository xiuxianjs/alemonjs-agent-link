import { DSHError, getDSHConfig, toUserMessage } from "../../dsh/client.js";
import { ownerPrivatePolicy } from "../../state/registry.js";
import { buildRecentChatContext, getRecentMessages } from "../../chat-context/store.js";
import { ensureIsolatedGroup, runCoordinatedChat } from "../../dsh/orchestrator.js";
import { StreamOutput } from "../../dsh/output.js";
import { Format, logger, useMessage } from "alemonjs";

//#region src/response/dsh/chat.ts
const buildAgentMessage = (recentContext, prompt) => {
	if (!recentContext) return prompt;
	return `${recentContext}\n\n<current_request>\n${prompt}\n</current_request>`;
};
const runDSHChat = async (event, prompt) => {
	const [message] = useMessage();
	const reply = async (text) => await message.send({ format: Format.create().addMarkdownOriginal(text) });
	let firstAgentReply = true;
	const replyAgent = async (text) => {
		const format = Format.create();
		if (firstAgentReply && event.UserId) format.addMention(event.UserId).addText("\n");
		format.addMarkdownOriginal(text);
		const result = await message.send({
			format,
			replyId: firstAgentReply ? event.MessageId : void 0
		});
		firstAgentReply = false;
		return result;
	};
	let config;
	if (event.IsPrivate && !event.IsMaster) {
		await reply("仅机器人主人可在私聊中使用 Agent。");
		return;
	}
	const channelId = event.IsPrivate ? `private:${event.UserKey || "master"}` : event.ChannelId;
	if (!channelId) {
		await reply("无法识别当前会话。");
		return;
	}
	try {
		config = getDSHConfig();
	} catch (error) {
		logger.error({ err: error }, "DSH configuration invalid");
		await reply(toUserMessage(error));
		return;
	}
	let recentContext;
	try {
		await ensureIsolatedGroup(channelId, config);
		recentContext = buildRecentChatContext(await getRecentMessages(channelId, {
			maxMessages: config.recentChatMaxMessages,
			windowSeconds: config.recentChatWindowSeconds,
			maxChars: config.recentChatMaxChars
		}, config, event.MessageId), config.recentChatSummaryMaxChars);
	} catch (error) {
		logger.warn({ err: error }, "Redis unavailable for chat context");
		await reply("会话服务暂时不可用，请稍后重试。");
		return;
	}
	logger.info({
		group: "redacted",
		messageLength: prompt.length,
		recentContextLength: recentContext.length
	}, "DSH chat requested");
	const output = new StreamOutput(replyAgent, config.maxMessageLength, config.streamFlushIntervalMs, (error) => {
		logger.error({ err: error }, "QQ message send failed");
	});
	let coordinated;
	try {
		coordinated = await runCoordinatedChat({
			...event,
			ChannelId: channelId
		}, buildAgentMessage(recentContext, prompt), (streamEvent) => {
			if (streamEvent.type === "content") output.append(streamEvent.content);
			return Promise.resolve();
		}, void 0, void 0, event.IsPrivate ? ownerPrivatePolicy : void 0);
		if (coordinated.duplicate) {
			await output.close();
			return;
		}
		if (!await output.close()) {
			await coordinated.release().catch((error) => logger.warn({ err: error }, "Unable to release undelivered DSH response"));
			await reply("Agent 未生成可显示的回复，请先发送 /agentstatus 确认服务状态后重试。");
			return;
		}
		await coordinated.confirmDelivery().catch((error) => logger.warn({ err: error }, "Unable to finalize DSH response delivery"));
	} catch (error) {
		await coordinated?.release().catch((releaseError) => logger.warn({ err: releaseError }, "Unable to release failed DSH response"));
		await output.close();
		if (error instanceof DSHError && error.kind === "cancelled") return;
		if (error instanceof DSHError && error.kind === "migration") logger.info({ group: "redacted" }, "DSH chat awaits isolated-session migration");
		else if (error instanceof DSHError && error.kind === "timeout") logger.warn({ group: "redacted" }, "DSH chat timed out; worker was reaped");
		else logger.error({ err: error }, "DSH chat failed");
		await reply(toUserMessage(error));
	}
};

//#endregion
export { runDSHChat };