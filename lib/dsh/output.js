//#region src/dsh/output.ts
const characterLength = (value) => Array.from(value).length;
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
const safeBoundary = (value, limit) => {
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
		if (/^\s*\n$/u.test(line) && characterLength(value.slice(0, position)) <= limit) candidate = position;
	}
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
const finalMarkdown = (value) => {
	let fence = null;
	for (const line of value.split(/(?<=\n)/u)) {
		const opener = fenceAt(line);
		if (!fence && opener) fence = opener;
		else if (fence && closesFence(line, fence)) fence = null;
	}
	return fence ? `${value}${value.endsWith("\n") ? "" : "\n"}${fence.marker.repeat(fence.length)}` : value;
};
const oversizedFallback = (value, limit) => {
	const wrapperLength = characterLength("```text\n\n```");
	const [part, remainder] = takeCharacters(value, Math.max(1, limit - wrapperLength));
	return [`\`\`\`text\n${part}\n\`\`\``, remainder];
};
var StreamOutput = class {
	send;
	maxMessageLength;
	onSendError;
	buffer = "";
	timer;
	sentContent = false;
	queue = Promise.resolve();
	constructor(send, maxMessageLength, flushIntervalMs, onSendError) {
		this.send = send;
		this.maxMessageLength = maxMessageLength;
		this.onSendError = onSendError;
		this.timer = setInterval(() => {
			this.flush(false);
		}, flushIntervalMs);
	}
	append(content) {
		this.buffer += content;
	}
	async flush(final = false) {
		const run = async () => {
			while (this.buffer) {
				const boundary = safeBoundary(this.buffer, this.maxMessageLength);
				if (boundary !== null) {
					const part = this.buffer.slice(0, boundary);
					this.buffer = this.buffer.slice(boundary);
					await this.sendPart(part);
					continue;
				}
				if (!final && characterLength(this.buffer) <= this.maxMessageLength) return;
				if (final) {
					const complete = finalMarkdown(this.buffer);
					if (characterLength(complete) <= this.maxMessageLength) {
						this.buffer = "";
						await this.sendPart(complete);
						continue;
					}
				}
				const [part, remainder] = oversizedFallback(this.buffer, this.maxMessageLength);
				this.buffer = remainder;
				await this.sendPart(part);
			}
		};
		const result = this.queue.then(run, run);
		this.queue = result.then(() => void 0, () => void 0);
		await result;
	}
	async sendPart(part) {
		if (!part.trim()) return;
		try {
			await this.send(part);
			this.sentContent = true;
		} catch (error) {
			this.onSendError(error);
		}
	}
	async close() {
		clearInterval(this.timer);
		await this.flush(true);
		return this.sentContent;
	}
};

//#endregion
export { StreamOutput };