// src/social/conversation-threads.ts
/** Short-lived, per-speaker invitations. A cleared ticket cannot be restored by a late reply. */
var ConversationThreads = class {
	threads = /* @__PURE__ */ new Map();
	key(speaker) {
		return JSON.stringify([speaker.platform || "", speaker.userId]);
	}
	prune(now) {
		for (const [key, value] of this.threads) if (value.expires <= now) this.threads.delete(key);
	}
	exchange(speaker, now) {
		this.prune(now);
		return this.threads.get(this.key(speaker))?.exchange;
	}
	begin(speaker, now) {
		this.prune(now);
		const key = this.key(speaker);
		const ticket = {
			userKey: speaker.userKey,
			expires: now + 12e4,
			exchange: this.threads.get(key)?.exchange
		};
		this.threads.delete(key);
		this.threads.set(key, ticket);
		while (this.threads.size > 100) this.threads.delete(this.threads.keys().next().value);
		return ticket;
	}
	delivered(speaker, replyText, now, ticket) {
		if (!replyText.trim() || this.threads.get(this.key(speaker)) !== ticket) return;
		ticket.exchange = {
			userText: speaker.text.slice(0, 1e3),
			replyText: replyText.slice(0, 2e3),
			at: now
		};
		ticket.expires = now + 12e4;
	}
	end(speaker) {
		return this.threads.delete(this.key(speaker));
	}
	clear(userKey) {
		let changed = false;
		for (const [key, value] of this.threads) if (userKey === void 0 || value.userKey === userKey) {
			this.threads.delete(key);
			changed = true;
		}
		return changed;
	}
};

export { ConversationThreads };