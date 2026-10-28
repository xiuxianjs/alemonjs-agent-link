import { getMediaConfig } from "./config.js";
import { ResultCode, useClient } from "alemonjs";

// src/media/onebot-transcript.ts
const currentVoiceTranscript = async (event) => {
	const media = event.MessageMedia;
	const audio = media?.filter((item) => item.Type === "audio") || [];
	if (event.Platform !== "onebot" || !event.MessageId || audio.length !== 1 || audio[0].Transcript?.trim()) return media;
	try {
		const [client] = useClient(event);
		try {
			const result = await client.agentLink.transcribeCurrentVoice();
			const text = result?.length === 1 && result[0].code === ResultCode.Ok ? result[0].data?.text : void 0;
			if (typeof text === "string" && text.trim() && text.length <= 12e3) return media?.map((item) => item === audio[0] ? {
				...item,
				Transcript: text.trim()
			} : item);
		} catch {}
		if (!getMediaConfig().asr || !audio[0]._onebotRecordFile) return media;
		const result = await client.agentLink.convertCurrentVoice();
		const converted = result?.length === 1 && result[0].code === ResultCode.Ok ? result[0].data : void 0;
		if (typeof converted?.base64 === "string") return media?.map((item) => item === audio[0] ? {
			...item,
			_onebotWav: converted.base64
		} : item);
		const url = converted?.url;
		if (typeof url === "string") return media?.map((item) => item === audio[0] ? {
			...item,
			AudioUrl: url
		} : item);
		return media;
	} catch {
		return media;
	}
};

export { currentVoiceTranscript };