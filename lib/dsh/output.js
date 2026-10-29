import { polishNetSavvy } from "./reply-format.js";
import { ResultCode } from "alemonjs";

// src/dsh/output.ts
const assertMessageDelivered = (receipts) => {
	if (!Array.isArray(receipts) || receipts.length === 0 || receipts.some((receipt) => receipt?.code !== ResultCode.Ok)) throw new Error("消息发送未得到全部成功回执。");
};
const characterLength = (value) => Array.from(value).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const takeCharacters = (value, limit) => {
	const characters = Array.from(value);
	return [characters.slice(0, limit).join(""), characters.slice(limit).join("")];
};
const fenceAt = (line) => {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n?$/);
	return match ? {
		marker: match[1][0],
		length: match[1].length
	} : null;
};
const closesFence = (line, fence) => {
	const match = line.match(/^ {0,3}(`{3,}|~{3,})\s*\n?$/);
	return match?.[1][0] === fence.marker && match[1].length >= fence.length;
};
const safeBoundary = (value, limit, sentences = true) => {
	let position = 0;
	let candidate = null;
	let fence = null;
	for (const line of value.split(/(?<=\n)/u)) {
		position += line.length;
		const opener = fenceAt(line);
		if (fence) {
			if (closesFence(line, fence) && characterLength(value.slice(0, position)) <= limit) {
				candidate = position;
				fence = null;
			}
			continue;
		}
		if (opener) {
			fence = opener;
			continue;
		}
		if (/^\s*\n$/u.test(line) && characterLength(value.slice(0, position)) <= limit) {
			candidate = position;
			continue;
		}
		if (line.trim() && line.endsWith("\n") && !/^\s*(?:[-*+•·]|\d+[.、)])\s+/u.test(line) && !/^\s*#/u.test(line) && !line.includes("|") && characterLength(value.slice(0, position)) <= limit) candidate = position;
	}
	if (!sentences) return candidate;
	const hasInlineMarkdown = [
		"`",
		"*",
		"_",
		"~",
		"[",
		"]",
		"<",
		">"
	].some((token) => value.includes(token));
	if (!fence && !hasInlineMarkdown) for (const match of value.matchAll(/[。！？!?](?=\s|$)/gu)) {
		const end = match.index + match[0].length;
		if (characterLength(value.slice(0, end)) <= limit) candidate = Math.max(candidate ?? 0, end);
	}
	return candidate;
};
const oversizedFallback = (value, limit) => {
	const wrapperLength = characterLength("```text\n\n```");
	if (limit <= wrapperLength) return takeCharacters(value, limit);
	const [part, remainder] = takeCharacters(value, limit - wrapperLength);
	return [`\`\`\`text\n${part}\n\`\`\``, remainder];
};
const finalBubbles = (value, limit) => {
	const raw = value.replace(/\|\|\|/gu, "\n");
	if (!raw.trim()) return [];
	if (/```|~~~/u.test(raw)) return [raw];
	const text = raw.trim();
	const lines = text.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
	if (lines.length <= 1) return [text];
	if (lines.filter((line) => /^(?:[-*+•·]|\d+[.、)])/u.test(line)).length >= Math.ceil(lines.length / 2) || lines.some((line) => line.startsWith("|"))) return [text];
	if (lines.length <= limit) return lines;
	return [...lines.slice(0, Math.max(0, limit - 1)), lines.slice(Math.max(0, limit - 1)).join("\n")];
};
var StreamOutput = class {
	send;
	maxMessageLength;
	onSendError;
	maxParts;
	bubbleDelayMs;
	buffer = "";
	timer;
	sentContent = false;
	failed = false;
	stopped = false;
	detachAbort;
	queue = Promise.resolve();
	partsSent = 0;
	constructor(send, maxMessageLength, flushIntervalMs, onSendError, maxParts = 5, bubbleDelayMs = 0) {
		this.send = send;
		this.maxMessageLength = maxMessageLength;
		this.onSendError = onSendError;
		this.maxParts = maxParts;
		this.bubbleDelayMs = bubbleDelayMs;
		this.timer = setInterval(() => {
			this.flush(false);
		}, flushIntervalMs);
	}
	append(content) {
		if (!this.stopped && !this.failed) this.buffer += content;
	}
	bindSignal(signal) {
		this.detachAbort?.();
		const stop = () => this.abort();
		signal.addEventListener("abort", stop, { once: true });
		this.detachAbort = () => signal.removeEventListener("abort", stop);
		if (signal.aborted) this.abort();
	}
	abort() {
		this.stopped = true;
		this.buffer = "";
		clearInterval(this.timer);
		this.detachAbort?.();
	}
	async flush(final = false) {
		const run = async () => {
			if (final) {
				const bubbles = finalBubbles(this.buffer, Math.max(1, this.maxParts - this.partsSent));
				this.buffer = "";
				for (let index = 0; index < bubbles.length; index++) {
					if (this.stopped || this.failed) return;
					await this.sendBubble(bubbles[index]);
					if (index < bubbles.length - 1 && this.bubbleDelayMs > 0 && !this.stopped && !this.failed) await sleep(this.bubbleDelayMs);
				}
				return;
			}
			while (this.buffer && !this.stopped && !this.failed) {
				const delimiter = this.buffer.indexOf("|||");
				if (delimiter !== -1) {
					const part = this.buffer.slice(0, delimiter);
					this.buffer = this.buffer.slice(delimiter + 3).replace(/^\s+/u, "");
					if (part.trim()) await this.sendBubble(part);
					continue;
				}
				if (this.partsSent >= Math.max(1, this.maxParts - 1) && characterLength(this.buffer) <= this.maxMessageLength) return;
				const boundary = safeBoundary(this.buffer, this.maxMessageLength, true);
				if (boundary !== null) {
					const part = this.buffer.slice(0, boundary);
					this.buffer = this.buffer.slice(boundary);
					await this.sendBubble(part);
					continue;
				}
				if (characterLength(this.buffer) <= this.maxMessageLength) return;
				const [part, remainder] = oversizedFallback(this.buffer, this.maxMessageLength);
				this.buffer = remainder;
				await this.sendBubble(part);
			}
		};
		const result = this.queue.then(run, run);
		this.queue = result.then(() => void 0, () => void 0);
		await result;
	}
	async sendBubble(text) {
		let rest = /```|~~~/u.test(text) ? text : text.trim();
		if (!rest.trim()) return;
		while (rest && !this.stopped && !this.failed) {
			if (characterLength(rest) <= this.maxMessageLength) {
				await this.sendPart(rest);
				return;
			}
			const [part, remainder] = oversizedFallback(rest, this.maxMessageLength);
			await this.sendPart(part);
			rest = remainder;
		}
	}
	async sendPart(part) {
		if (!part.trim() || this.stopped || this.failed) return;
		try {
			await this.send(polishNetSavvy(part));
			this.sentContent = true;
			this.partsSent += 1;
		} catch (error) {
			this.failed = true;
			this.buffer = "";
			clearInterval(this.timer);
			this.onSendError(error);
		}
	}
	async close() {
		clearInterval(this.timer);
		await this.flush(true);
		this.detachAbort?.();
		return this.sentContent && !this.failed && !this.stopped;
	}
};

export { StreamOutput, assertMessageDelivered };