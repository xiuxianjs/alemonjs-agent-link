// src/dsh/input.ts
const MAX_IMAGE_REQUEST_BYTES = 50331648;
const inputText = (input) => typeof input === "string" ? input : input.filter((part) => part.type === "text").map((part) => part.text).join("\n");
const withInputContext = (input, context) => !context ? input : typeof input === "string" ? `${context}\n\n当前消息：\n${input}` : [{
	type: "text",
	text: context
}, ...input];
const modelContent = (input) => typeof input === "string" ? input : input.map((part) => part.type === "text" ? part : {
	type: "image_url",
	image_url: { url: `data:${part.mimeType};base64,${part.data}` }
});

export { MAX_IMAGE_REQUEST_BYTES, inputText, modelContent, withInputContext };