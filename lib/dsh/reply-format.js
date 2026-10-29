import { Format } from "alemonjs";

// src/dsh/reply-format.ts
/** Bubble delimiters are transport markers, never conversation content. */
const normalizeBubbleText = (text) => text.replace(/\|\|\|/gu, "\n").trim();
var ReplyPrefixFilter = class {
	prefix = "";
	decided = false;
	push(content) {
		if (this.decided) return content;
		this.prefix += content;
		const start = this.prefix.trimStart();
		if (this.prefix.length <= 64 && (!start || "<reply:".startsWith(start) || /^<reply:m\d*$/u.test(start))) return "";
		this.decided = true;
		return this.prefix.replace(/^\s*<reply:m\d+>\s*/u, "");
	}
};
const createChatReplyFormat = (text, platform, mentionUserId) => {
	const format = Format.create();
	if (mentionUserId) format.addMention(mentionUserId).addText("\n");
	if (platform === "qq-bot" && mentionUserId) format.addMarkdownOriginal(text);
	else format.addText(text);
	return format;
};
/** Model-directed voice: the tag is transport metadata, never conversation content. */
const extractVoiceTag = (text) => {
	const voice = /<voice>[\s\S]*?<\/voice>/u.test(text);
	return {
		text: text.replace(/<\/?voice>/gu, "").trim(),
		voice
	};
};
/** Lightweight net-savvy eraser: only removes obvious assistant padding, never code. */
const polishNetSavvy = (text) => {
	if (/```|~~~/u.test(text)) return text;
	return text.replace(/^(\s*)作为(?:一个)?AI(?:助手)?[，,]\s*/u, "$1").replace(/^(\s*)好的主人[，,]\s*/u, "$1").replace(/(^|[。！？!?，,]\s*)我这边/gu, "$1我").replace(/我?帮你看看/gu, "我看看").replace(/(?:希望)?(?:这|以上)?(?:能|对你)?有(?:所)?帮助[。！!]?\s*$/u, "").trim() || text.trim();
};
/** 群聊非直接回复的软上限：不截代码、链接和表格，普通长文在句末收住。 */
const SOCIAL_REPLY_MAX_CHARS = 220;
const trimSocialReply = (text, maxChars = 220) => {
	const value = text.trim();
	if (!value || Array.from(value).length <= maxChars || /```|~~~|https?:\/\/|\|.*\|/u.test(value)) return value;
	const head = Array.from(value).slice(0, maxChars).join("");
	const cut = Math.max(...[
		"。",
		"！",
		"？",
		"!",
		"?",
		"\n"
	].map((mark) => head.lastIndexOf(mark)));
	if (cut >= Math.floor(maxChars * .6)) return head.slice(0, cut + 1).trim();
	return `${head.replace(/[，,、；;：:\s]+$/u, "")}…`;
};

export { ReplyPrefixFilter, SOCIAL_REPLY_MAX_CHARS, createChatReplyFormat, extractVoiceTag, normalizeBubbleText, polishNetSavvy, trimSocialReply };