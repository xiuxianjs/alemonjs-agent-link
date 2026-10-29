import { ResultCode, useClient } from "alemonjs";

// src/media/onebot-sticker-send.ts
/**
* Send an image as a OneBot sticker segment (`sub_type=1`). Returns undefined when the current
* platform/gateway cannot handle the dedicated action, so callers can fall back to normal media.
*/
const sendOnebotSticker = async (event, data, replyId) => {
	if (event.Platform !== "onebot" || data.length === 0 || data.length > 5242880) return void 0;
	try {
		const [client] = useClient(event);
		const result = await client.agentLink.sendSticker({
			data: data.toString("base64"),
			...replyId ? { replyId } : {}
		});
		if (!Array.isArray(result) || result.length !== 1 || result[0].code !== ResultCode.Ok) return void 0;
		const messageId = result[0].data?.messageId;
		return typeof messageId === "string" && messageId ? { messageId } : void 0;
	} catch {
		return;
	}
};

export { sendOnebotSticker };