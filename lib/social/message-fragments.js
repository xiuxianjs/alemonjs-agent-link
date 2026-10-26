// src/social/message-fragments.ts
const speechControl = (text) => {
	const value = text.trim().replace(/^(?:大肥鱼|小肥鱼|肥鱼|deepseek|dsh)[，,：:\s]*/iu, "").replace(/[。！!，,~～]+$/u, "");
	if (/^(?:别回了|别回复了|不用回复|不用回答|不要回复|不要回答|停止回复|停止回答)$/u.test(value)) return "stop";
	if (/^(?:等我说完|等我发完|等我发完再回|我还没说完|先别回|先别回复|先别回答|让我说完)$/u.test(value)) return "hold";
	if (/^(?:说完了|发完了|可以回了|可以回复了|可以回答了|现在可以回复了)$/u.test(value)) return "release";
};
var MessageFragments = class {
	users = /* @__PURE__ */ new Map();
	key(message) {
		return JSON.stringify([message.platform || "", message.userId]);
	}
	prune(now) {
		for (const [key, value] of this.users) if (value.expires <= now) this.users.delete(key);
	}
	holding(message, now) {
		this.prune(now);
		return Boolean(this.users.get(this.key(message))?.holding);
	}
	save(messages, now, holding = false) {
		this.prune(now);
		for (const message of messages) {
			const key = this.key(message);
			const value = this.users.get(key) || {
				messages: [],
				expires: now + 45e3,
				holding
			};
			value.holding ||= holding;
			if (!value.messages.some((item) => item.id && item.id === message.id)) value.messages.push(message);
			while (value.messages.length > 20 || value.messages.reduce((sum, item) => sum + item.text.length + (item.referenceContext?.length || 0), 0) > 6e3) value.messages.shift();
			value.expires = now + (value.holding ? 12e4 : 45e3);
			this.users.delete(key);
			this.users.set(key, value);
			while (this.users.size > 100) this.users.delete(this.users.keys().next().value);
		}
	}
	take(message, now) {
		this.prune(now);
		const key = this.key(message);
		const value = this.users.get(key);
		this.users.delete(key);
		return value?.messages || [];
	}
	clear(userKey) {
		const before = this.users.size;
		if (userKey === void 0) {
			this.users.clear();
			return before > 0;
		}
		for (const [key, value] of this.users) if (value.messages.some((message) => message.userKey === userKey)) this.users.delete(key);
		return this.users.size < before;
	}
};

export { MessageFragments, speechControl };