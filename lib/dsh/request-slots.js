import { DSHError } from "./errors.js";
import { setTimeout } from "node:timers/promises";

// src/dsh/request-slots.ts
var RequestSlotPool = class {
	count = 0;
	waiting = [];
	get active() {
		return this.count;
	}
	grant() {
		this.count++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.count--;
			this.drain();
		};
	}
	acquire(limit) {
		if (this.count >= limit || this.waiting.length) throw new DSHError("http", "Agent 服务繁忙，请稍后重试");
		return this.grant();
	}
	drain() {
		while (this.waiting.length) {
			const next = this.waiting[0];
			if (this.count >= next.limit) return;
			this.waiting.shift();
			next.signal.removeEventListener("abort", next.abort);
			if (next.signal.aborted) next.reject(next.signal.reason);
			else next.resolve(this.grant());
		}
	}
	async requeue(release, limit, signal) {
		release();
		await setTimeout(0, void 0, { signal });
		signal.throwIfAborted();
		return await new Promise((resolve, reject) => {
			const waiter = {
				limit,
				signal,
				resolve,
				reject,
				abort: () => {
					this.waiting = this.waiting.filter((item) => item !== waiter);
					reject(signal.reason);
					this.drain();
				}
			};
			this.waiting.push(waiter);
			signal.addEventListener("abort", waiter.abort, { once: true });
			if (signal.aborted) waiter.abort();
			else this.drain();
		});
	}
};

export { RequestSlotPool };