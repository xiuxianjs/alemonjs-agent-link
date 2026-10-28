import { ResultCode, logger, useClient } from "alemonjs";

// src/dsh/qq-stream.ts
const supportsQQStream = (event, available) => available && event.Platform === "qq-bot" && Boolean(event.IsPrivate && event.MessageId) && (!event.Target || event.Target.scope === "c2c");
const createQQSequenceAllocator = (replyId) => {
	const [client] = useClient();
	return async () => {
		const [result] = await client.getMessageSeq(replyId);
		if (result?.code !== ResultCode.Ok || !Number.isInteger(result.data) || result.data < 1) throw new Error("QQ 消息序号分配失败");
		return result.data;
	};
};
var QQStreamOutput = class {
	send;
	replyId;
	maxBytes;
	onDelivered;
	allocateSequence;
	text = "";
	sent = "";
	id;
	index = 0;
	sequence;
	stopped = false;
	failed = false;
	timer;
	task = Promise.resolve();
	busy = false;
	lastSentAt = 0;
	detach;
	receipt;
	constructor(send, replyId, maxBytes, onDelivered, allocateSequence) {
		this.send = send;
		this.replyId = replyId;
		this.maxBytes = maxBytes;
		this.onDelivered = onDelivered;
		this.allocateSequence = allocateSequence;
	}
	append(delta) {
		if (this.stopped || this.failed) return;
		this.text += delta;
		if (Buffer.byteLength(this.text) > this.maxBytes) {
			this.failed = true;
			return;
		}
		this.schedule();
	}
	bindSignal(signal) {
		this.detach?.();
		const abort = () => this.abort();
		signal.addEventListener("abort", abort, { once: true });
		this.detach = () => signal.removeEventListener("abort", abort);
		if (signal.aborted) this.abort();
	}
	schedule() {
		if (this.busy || this.timer || this.stopped || this.failed || this.text === this.sent) return;
		const delay = Math.max(0, 500 - (Date.now() - this.lastSentAt));
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.busy = true;
			this.task = this.update(false).catch(() => {
				logger.warn({ index: this.index }, "QQ stream update failed");
				this.failed = true;
			}).finally(() => {
				this.busy = false;
				this.schedule();
			});
		}, delay);
	}
	async update(complete) {
		if (this.stopped || this.failed || !this.text) return;
		const snapshot = this.text;
		this.sequence ??= await this.allocateSequence();
		if (this.stopped) return;
		this.lastSentAt = Date.now();
		const result = await this.send({
			text: snapshot,
			mode: "replace",
			state: complete ? "complete" : "generating",
			contentType: "text",
			sequence: this.sequence,
			index: this.index,
			streamId: this.id,
			replyId: this.replyId
		});
		if (result.code !== ResultCode.Ok || !result.data?.id) throw new Error("QQ 流发送失败");
		this.id ||= result.data.id;
		this.index++;
		this.sent = snapshot;
		this.receipt = result.data;
	}
	async close() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		await this.task;
		if (this.stopped || this.failed || !this.text) {
			this.abort();
			return false;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		const delay = Math.max(0, 500 - (Date.now() - this.lastSentAt));
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			await this.update(true);
			if (this.stopped || this.failed || !this.receipt) return false;
			await this.onDelivered(this.receipt, this.sent);
			return true;
		} catch {
			return false;
		} finally {
			this.abort();
		}
	}
	abort() {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		this.detach?.();
	}
};

export { QQStreamOutput, createQQSequenceAllocator, supportsQQStream };