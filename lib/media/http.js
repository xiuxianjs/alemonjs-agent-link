import { MediaError } from "./config.js";

// src/media/http.ts
var MediaHttpError = class extends MediaError {
	status;
	constructor(status) {
		super(`媒体服务返回 HTTP ${status}。`);
		this.status = status;
	}
};
const readBounded = async (response, maxBytes) => {
	if (!response.ok) {
		await response.body?.cancel();
		throw new MediaHttpError(response.status);
	}
	if (!response.body) throw new MediaError("媒体服务返回空内容。");
	const reader = response.body.getReader();
	const chunks = [];
	let bytes = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > maxBytes) throw new MediaError("媒体服务响应超过限制。");
			chunks.push(part.value);
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(chunks);
};

export { MediaHttpError, readBounded };