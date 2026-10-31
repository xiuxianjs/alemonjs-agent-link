import { randomBytes } from "node:crypto";

// src/credentials/key-intake.ts
const extractApiKeys = (text) => [...new Set([...text.matchAll(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,240}(?![A-Za-z0-9_-])/gu)].map((match) => match[0]).filter((key) => !/^sk-(?:your[-_]?key|your[-_]?api[-_]?key|placeholder)$/iu.test(key)))];
var KeyIntake = class {
	now;
	pending = /* @__PURE__ */ new Map();
	constructor(now = Date.now) {
		this.now = now;
	}
	offer(actor, key) {
		for (const [id, item] of this.pending) if (!item.busy && (item.expires <= this.now() || item.actor === actor)) this.pending.delete(id);
		if (this.pending.size >= 1e3) throw new Error("添加请求较多，请稍后重试。");
		const id = randomBytes(16).toString("hex");
		this.pending.set(id, {
			actor,
			key,
			expires: this.now() + 3e5,
			busy: false
		});
		return id;
	}
	async confirm(actor, id, save) {
		const item = this.pending.get(id);
		if (item?.actor !== actor || item.expires <= this.now()) {
			if (item?.expires <= this.now() && !item.busy) this.pending.delete(id);
			throw new Error("这次添加已失效，请重新私聊发送 Key。");
		}
		if (item.busy) throw new Error("正在添加，请勿重复点击。");
		item.busy = true;
		try {
			await save(item.key);
			this.pending.delete(id);
		} catch (error) {
			item.busy = false;
			throw error;
		}
	}
};
const keyIntake = new KeyIntake();

export { KeyIntake, extractApiKeys, keyIntake };