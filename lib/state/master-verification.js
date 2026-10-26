import { randomInt } from "node:crypto";

// src/state/master-verification.ts
const lifetimeMs = 3e5;
var MasterVerification = class {
	pending = /* @__PURE__ */ new Map();
	issue(identity, now = Date.now()) {
		for (const [key, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(key);
		const code = String(randomInt(1e5, 1e6));
		this.pending.set(identity, {
			code,
			expiresAt: now + lifetimeMs,
			attempts: 0
		});
		return code;
	}
	verify(identity, code, now = Date.now()) {
		const entry = this.pending.get(identity);
		if (!entry || entry.expiresAt <= now) {
			this.pending.delete(identity);
			return false;
		}
		entry.attempts += 1;
		const valid = entry.code === code;
		if (valid || entry.attempts >= 5) this.pending.delete(identity);
		return valid;
	}
};
const masterVerification = new MasterVerification();

export { MasterVerification, masterVerification };