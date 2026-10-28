// src/social/loop-guard.ts
const normalize = (text) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "").slice(0, 2e3);
var LoopGuard = class {
	peers = /* @__PURE__ */ new Map();
	outputs = [];
	allows(user, text, now, isBot = false, explicit = false) {
		if (isBot) return false;
		const peer = this.peers.get(user);
		if (peer && peer.blockedUntil > now && !(explicit && peer.blockedFor === "rate")) return false;
		const key = normalize(text);
		const repeated = key.length >= 8 && peer?.lastSeen > now - 12e4 && peer.inputs.includes(key);
		const echo = key.length >= 12 && this.outputs.some((item) => now - item.at < 12e4 && item.text === key);
		const excessive = !explicit && peer && peer.replies.filter((at) => now - at < 12e4).length >= 4;
		if (repeated || echo || excessive) {
			if (peer) {
				peer.blockedUntil = now + 12e4;
				peer.blockedFor = repeated || echo ? "loop" : "rate";
			}
			return false;
		}
		return true;
	}
	delivered(user, input, output, now) {
		for (const [id, peer] of this.peers) if (now - peer.lastSeen > 24e4) this.peers.delete(id);
		if (!this.peers.has(user) && this.peers.size >= 1e3) this.peers.delete(this.peers.keys().next().value);
		const previous = this.peers.get(user);
		this.peers.set(user, {
			replies: [...(previous?.replies || []).filter((at) => now - at < 12e4), now],
			inputs: [...previous && now - previous.lastSeen < 12e4 ? previous.inputs : [], normalize(input)].slice(-4),
			blockedUntil: previous?.blockedUntil || 0,
			blockedFor: previous?.blockedFor,
			lastSeen: now
		});
		if (output) this.outputs = [...this.outputs.filter((item) => now - item.at < 12e4), {
			at: now,
			text: normalize(output)
		}].slice(-16);
	}
};

export { LoopGuard };