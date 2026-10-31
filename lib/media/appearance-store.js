import { validPersonaId } from "../companion/personas.js";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

// src/media/appearance-store.ts
var AppearanceStore = class {
	db;
	constructor(path) {
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		this.db = new DatabaseSync(path);
		chmodSync(path, 384);
		this.db.exec("PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS appearances (id TEXT PRIMARY KEY, persona TEXT NOT NULL, payload TEXT NOT NULL, image BLOB NOT NULL)");
	}
	list(personaId) {
		return (personaId ? this.db.prepare("SELECT payload FROM appearances WHERE persona=?").all(personaId) : this.db.prepare("SELECT payload FROM appearances").all()).map((row) => JSON.parse(String(row.payload))).sort((a, b) => Number(b.primary) - Number(a.primary) || b.createdAt - a.createdAt);
	}
	read(id, personaId) {
		const row = this.db.prepare("SELECT payload,image FROM appearances WHERE id=?").get(id);
		if (!row) throw new Error("形象不存在");
		const item = JSON.parse(String(row.payload));
		if (personaId && item.personaId !== personaId) throw new Error("形象不属于当前人设");
		return {
			item,
			data: Buffer.from(row.image)
		};
	}
	async add(personaId, name, data, parentId = "") {
		if (!validPersonaId(personaId) || typeof name !== "string" || !name.trim() || name.length > 80 || data.length > 5242880) throw new Error("形象内容无效，图片最多5MB");
		const metadata = await sharp(data, { limitInputPixels: 16e6 }).metadata();
		if (![
			"png",
			"jpeg",
			"webp"
		].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error("只接受静态PNG、JPEG、WebP");
		const image = await sharp(data, { limitInputPixels: 16e6 }).rotate().png().toBuffer();
		if (image.length > 8388608) throw new Error("转换后的图片过大");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (parentId) this.read(parentId, personaId);
			if (this.list(personaId).length >= 100) throw new Error("每个人设最多100张形象");
			const item = {
				id: randomUUID(),
				personaId,
				name: name.trim(),
				parentId,
				primary: !this.list(personaId).length,
				createdAt: Date.now()
			};
			this.db.prepare("INSERT INTO appearances VALUES(?,?,?,?)").run(item.id, personaId, JSON.stringify(item), image);
			this.db.exec("COMMIT");
			return item;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	edit(id, action) {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const { item } = this.read(id);
			if (action === "primary") for (const row of this.list(item.personaId)) {
				row.primary = row.id === id;
				this.db.prepare("UPDATE appearances SET payload=? WHERE id=?").run(JSON.stringify(row), row.id);
			}
			else if (action === "delete") {
				if (this.list(item.personaId).some((row) => row.parentId === id)) throw new Error("请先删除该形象的二创版本");
				this.db.prepare("DELETE FROM appearances WHERE id=?").run(id);
				if (item.primary) {
					const next = this.list(item.personaId)[0];
					if (next) {
						next.primary = true;
						this.db.prepare("UPDATE appearances SET payload=? WHERE id=?").run(JSON.stringify(next), next.id);
					}
				}
			} else throw new Error("操作无效");
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	close() {
		this.db.close();
	}
};
const stores = /* @__PURE__ */ new Map();
const getAppearanceStore = (config) => {
	const path = join(dirname(config.workspaceRoot), "appearances.sqlite");
	if (!stores.has(path)) stores.set(path, new AppearanceStore(path));
	return stores.get(path);
};

export { AppearanceStore, getAppearanceStore };