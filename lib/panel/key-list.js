import { budgetRedis } from "../billing/budget.js";
import { createHash } from "node:crypto";
import { getConfigValue } from "alemonjs";

// src/panel/key-list.ts
const personalPrefix = "data:{agent-link-personal-keys}:v1:";
const ringPrefix = "data:{agent-link-group-keys}:v1:ring:";
const verifiedOwner = (value, id) => {
	const owner = value;
	if (!owner || typeof owner.platform !== "string" || typeof owner.userId !== "string") return null;
	return createHash("sha256").update(JSON.stringify([owner.platform, owner.userId])).digest("hex") === id ? {
		platform: owner.platform,
		userId: owner.userId
	} : null;
};
/** Read owned keys only. No decryption, provider calls, or robot-config credentials. */
const listUserKeys = async (redis) => {
	const records = [];
	const owners = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Set();
	const keyPrefix = redis.options?.keyPrefix || "";
	const escapedPrefix = keyPrefix.replace(/[\\*?[\]]/gu, "\\$&");
	for (const prefix of [personalPrefix, ringPrefix]) {
		let cursor = "0";
		do {
			const page = await redis.scan(cursor, "MATCH", `${escapedPrefix}${prefix}*`, "COUNT", 100);
			cursor = page[0];
			for (const full of page[1]) {
				const key = full.slice(keyPrefix.length);
				const ownerId = key.slice(prefix.length);
				if (!key.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(ownerId) || seen.has(key)) continue;
				seen.add(key);
				const raw = await redis.get(key);
				if (!raw) continue;
				const value = JSON.parse(raw);
				const owner = verifiedOwner(value.owner, ownerId);
				if (owner) owners.set(ownerId, owner);
				records.push({
					ownerId,
					purpose: prefix === personalPrefix ? "personal" : "group",
					value
				});
			}
		} while (cursor !== "0");
	}
	const keys = [];
	const add = (ownerId, purpose, number, value, grantRecords) => {
		if (!value || typeof value.encrypted !== "string" || !value.encrypted) return;
		const owner = owners.get(ownerId);
		keys.push({
			id: `${ownerId}:${purpose}:${number ?? "personal"}`,
			ownerId,
			platform: owner?.platform || null,
			userId: owner?.userId || null,
			purpose,
			number,
			apiKey: "***",
			auth: value.auth === "account" ? "account" : "api-key",
			enabled: value.enabled === true,
			reason: [
				"manual",
				"balance",
				"auth"
			].includes(value.reason) ? value.reason : "",
			grantRecords
		});
	};
	for (const { ownerId, purpose, value } of records) if (purpose === "personal") add(ownerId, purpose, null, value, 0);
	else for (const entry of Array.isArray(value.keys) ? value.keys : []) {
		if (!Number.isSafeInteger(entry.id) || entry.id < 1) continue;
		const grants = Array.isArray(value.grants) ? value.grants.filter((grant) => grant.keyId === entry.id).length : 0;
		add(ownerId, purpose, entry.id, entry.value, grants);
	}
	keys.sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.purpose.localeCompare(b.purpose) || (a.number || 0) - (b.number || 0));
	return {
		total: keys.length,
		keys
	};
};
const readKeyList = async () => {
	if (!getConfigValue()?.db?.redis) return {
		total: 0,
		keys: []
	};
	return listUserKeys(await budgetRedis());
};

export { listUserKeys, readKeyList };