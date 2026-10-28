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

export { ReplyPrefixFilter, createChatReplyFormat, normalizeBubbleText };