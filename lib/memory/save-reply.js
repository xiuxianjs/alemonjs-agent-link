import { requestedMemorySave } from "./save-intent.js";

// src/memory/save-reply.ts
const bufferUnavailableMemorySave = (privateChat, userText, tools) => privateChat && requestedMemorySave(userText) && !tools.some((tool) => tool.name === "remember_private_fact");
/** An echo is not a save confirmation. Leave actual answers and tool receipts alone. */
const resolveUnavailableMemoryEcho = (reply, userText) => {
	const normalize = (text) => text.normalize("NFKC").replace(/\s+/gu, "").replace(/[。.!！]+$/u, "");
	return normalize(reply.trim().replace(/^(?:user|human|用户)[：:\s]*/iu, "")) === normalize(userText) ? "这次没能确认长期保存。需要明确保存时，可用 /记住 加上要保存的内容。" : reply;
};

export { bufferUnavailableMemorySave, resolveUnavailableMemoryEcho };