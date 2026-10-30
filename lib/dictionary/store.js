import { dictionaryDefaults, dictionaryDefaultsVersion } from "./defaults.js";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// src/dictionary/store.ts
var DictionaryStore = class {
	db;
	constructor(path) {
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec("PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS words (id TEXT PRIMARY KEY, normalized TEXT UNIQUE NOT NULL, payload TEXT NOT NULL)");
		this.db.exec("CREATE TABLE IF NOT EXISTS dictionary_migrations (version TEXT PRIMARY KEY)");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (!this.db.prepare("SELECT version FROM dictionary_migrations WHERE version=?").get("2026-10-30-v1")) {
				for (const entry of dictionaryDefaults) {
					const word = {
						...entry,
						id: randomUUID(),
						enabled: true,
						updatedAt: Date.now()
					};
					this.db.prepare("INSERT OR IGNORE INTO words VALUES (?,?,?)").run(word.id, word.term.toLowerCase(), JSON.stringify(word));
				}
				this.db.prepare("INSERT INTO dictionary_migrations VALUES (?)").run(dictionaryDefaultsVersion);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}
	list() {
		return this.db.prepare("SELECT payload FROM words ORDER BY normalized").all().map((row) => JSON.parse(String(row.payload)));
	}
	save(input) {
		if (typeof input.term !== "string" || !input.term.trim() || input.term.trim().length > 60 || typeof input.definition !== "string" || !input.definition.trim() || input.definition.length > 2e3 || !Array.isArray(input.aliases) || input.aliases.length > 20 || input.aliases.some((a) => typeof a !== "string" || !a.trim() || a.length > 60) || typeof input.enabled !== "boolean") throw new Error("词条格式无效");
		const item = {
			id: input.id || randomUUID(),
			term: input.term.trim(),
			aliases: [...new Set(input.aliases.map((a) => a.trim()))],
			definition: input.definition.trim(),
			enabled: input.enabled,
			updatedAt: Math.max(Date.now(), (input.updatedAt || 0) + 1)
		};
		if (input.id) {
			if (!this.db.prepare("UPDATE words SET normalized=?, payload=? WHERE id=? AND json_extract(payload, '$.updatedAt')=?").run(item.term.toLowerCase(), JSON.stringify(item), item.id, input.updatedAt || 0).changes) throw new Error("配置已更新");
		} else this.db.prepare("INSERT INTO words VALUES (?,?,?)").run(item.id, item.term.toLowerCase(), JSON.stringify(item));
		return item;
	}
	remove(id, updatedAt) {
		if (!this.db.prepare("DELETE FROM words WHERE id=? AND json_extract(payload, '$.updatedAt')=?").run(id, updatedAt).changes) throw new Error("配置已更新");
	}
	match(text) {
		const query = text.toLowerCase();
		return this.list().filter((word) => word.enabled && [word.term, ...word.aliases].some((term) => {
			const needle = term.toLowerCase();
			if (!/^[a-z0-9_ ]+$/i.test(needle)) return query.includes(needle);
			return query.split(needle).some((part, index, parts) => index < parts.length - 1 && !/[a-z0-9_]$/.test(part) && !/^[a-z0-9_]/.test(parts[index + 1]));
		})).sort((a, b) => b.term.length - a.term.length).slice(0, 5);
	}
	close() {
		this.db.close();
	}
};
const stores = /* @__PURE__ */ new Map();
const getDictionaryStore = (config) => {
	const path = join(dirname(config.workspaceRoot || config.dshHomeRoot), "dictionary.sqlite");
	if (!stores.has(path)) stores.set(path, new DictionaryStore(path));
	return stores.get(path);
};

export { DictionaryStore, getDictionaryStore };