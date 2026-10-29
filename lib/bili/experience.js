// src/bili/experience.ts
/** Recover only our structured reading evidence, never BV mentions in arbitrary memories. */
const recentBiliIds = (items, now = Date.now()) => {
	const ids = /* @__PURE__ */ new Set();
	for (const item of items) {
		if (item.status !== "active" || item.origin !== "event" || item.kind !== "event" || !item.tags.includes("B站") || item.createdAt < now - 6048e5) continue;
		const tagged = item.tags.find((tag) => /^BV[0-9A-Za-z]{10}$/u.test(tag));
		if (tagged) {
			ids.add(tagged);
			continue;
		}
		if (!item.text.startsWith("我读取了 B 站视频资料：")) continue;
		try {
			const details = JSON.parse(item.text.slice(item.text.indexOf("{"), item.text.lastIndexOf("}") + 1));
			if (typeof details.bvid === "string" && /^BV[0-9A-Za-z]{10}$/u.test(details.bvid)) ids.add(details.bvid);
		} catch {}
	}
	return ids;
};

export { recentBiliIds };