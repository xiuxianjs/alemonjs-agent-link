// src/social/group-wait.ts
const normalized = (text) => text.normalize("NFKC").toLocaleLowerCase("en-US");
/** Event-driven waiting: no model request or platform send is scheduled by a timeout. */
var GroupWaitController = class {
	persistence;
	slots = /* @__PURE__ */ new Map();
	createdAt = /* @__PURE__ */ new Map();
	constructor(persistence, now = Date.now()) {
		this.persistence = persistence;
		try {
			const saved = persistence?.load(now);
			if (saved) {
				this.slots.set(saved.platform, {
					platform: saved.platform,
					userKey: saved.userKey,
					plan: {
						...saved.plan,
						speakerIds: saved.plan.speakerIds.slice(),
						...saved.plan.speakerIds.length === 1 ? { speakerId: saved.plan.speakerIds[0] } : {}
					}
				});
				this.createdAt.set(saved.platform, saved.createdAt);
			}
		} catch {
			persistence?.failed?.();
		}
	}
	remove(platform) {
		this.slots.delete(platform);
		this.createdAt.delete(platform);
		try {
			this.persistence?.save();
			return true;
		} catch {
			this.persistence?.failed?.();
			return false;
		}
	}
	snapshot(platform, now) {
		const plan = this.slots.get(platform)?.plan;
		if (!plan) return void 0;
		if (plan.expiresAt <= now || now < (this.createdAt.get(platform) ?? now)) {
			this.remove(platform);
			return;
		}
		return {
			speakerIds: plan.speakerIds.slice(),
			keyword: plan.keyword,
			expiresAt: plan.expiresAt
		};
	}
	begin(platform, userKey) {
		const ticket = {
			platform,
			userKey
		};
		this.remove(platform);
		this.slots.set(platform, ticket);
		return ticket;
	}
	apply(ticket, request, knownSpeakers, currentSpeaker, now) {
		if (this.slots.get(ticket.platform) !== ticket) return {
			ok: false,
			message: "本轮等待设置已失效。"
		};
		if (ticket.plan?.expiresAt <= now || now < (this.createdAt.get(ticket.platform) ?? now)) {
			ticket.plan = void 0;
			this.createdAt.delete(ticket.platform);
			try {
				this.persistence?.save();
			} catch {
				this.persistence?.failed?.();
			}
		}
		if (request.action === "cancel") {
			ticket.plan = void 0;
			this.createdAt.delete(ticket.platform);
			try {
				this.persistence?.save();
			} catch {
				this.persistence?.failed?.();
				return {
					ok: false,
					state: "idle",
					message: "本进程已取消等待，但持久状态清理失败。"
				};
			}
		} else if (request.action === "wait") {
			const seconds = request.seconds ?? 120;
			const candidates = request.speakerIds ?? [request.speakerId ?? currentSpeaker];
			if (request.speakerId !== void 0 && request.speakerIds !== void 0 || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 5 || candidates.some((id) => typeof id !== "string" || !id || id.length > 200 || !knownSpeakers.includes(id))) return {
				ok: false,
				message: "等待名单须为1–5名当前回合已读取的发言人，speakerId与speakerIds不能同时提供。"
			};
			const speakerIds = [...new Set(candidates)];
			const keyword = (request.keyword ?? "").trim();
			if (!Number.isInteger(seconds) || seconds < 15 || seconds > 300 || keyword.length > 40 || /[\r\n\0]/u.test(keyword)) return {
				ok: false,
				message: "只能等待当前回合已读取的发言人，期限为15–300秒，关键词最多40字且为单行。"
			};
			const plan = {
				speakerId: speakerIds.length === 1 ? speakerIds[0] : void 0,
				speakerIds,
				keyword,
				expiresAt: now + seconds * 1e3
			};
			try {
				this.persistence?.save({
					platform: ticket.platform,
					userKey: ticket.userKey,
					createdAt: now,
					plan
				});
			} catch {
				this.persistence?.failed?.();
				return {
					ok: false,
					message: "等待状态保存失败，本次设置未生效。"
				};
			}
			ticket.plan = plan;
			this.createdAt.set(ticket.platform, now);
		} else if (request.action !== "status") return {
			ok: false,
			message: "等待动作无效。"
		};
		return ticket.plan ? {
			ok: true,
			state: "waiting",
			...ticket.plan,
			speakerIds: ticket.plan.speakerIds.slice()
		} : {
			ok: true,
			state: "idle"
		};
	}
	observe(message, now) {
		const platform = message.platform || "";
		const plan = this.slots.get(platform)?.plan;
		if (!plan) return "idle";
		if (plan.expiresAt <= now || now < (this.createdAt.get(platform) ?? now) || message.direct) {
			this.remove(platform);
			return "idle";
		}
		if (plan.speakerIds.includes(message.userId) && (!plan.keyword || normalized(message.text).includes(normalized(plan.keyword)))) return this.remove(platform) ? "matched" : "idle";
		return "waiting";
	}
	clear(userKey) {
		let changed = false;
		for (const [platform, ticket] of this.slots) if (userKey === void 0 || ticket.userKey === userKey) {
			this.remove(platform);
			changed = true;
		}
		return changed;
	}
};

export { GroupWaitController };