import { acquireProcessLock } from "../runtime/process-lock.js";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

// src/state/local-store.ts
const state = globalThis;
const stores = state.__agentLinkLocalStores ??= /* @__PURE__ */ new Map();
const getLocalStore = (path) => {
	let pending = stores.get(path);
	if (pending === void 0) {
		pending = LocalStore.open(path).catch((error) => {
			stores.delete(path);
			throw error;
		});
		stores.set(path, pending);
	}
	return pending.then((store) => {
		store.assertOwnership();
		return store;
	});
};
var LocalStore = class LocalStore {
	path;
	ownership;
	entries = Object.create(null);
	changed = false;
	queue = Promise.resolve();
	constructor(path, ownership) {
		this.path = path;
		this.ownership = ownership;
	}
	assertOwnership() {
		this.ownership.assertOwned();
	}
	static async open(path) {
		await mkdir(dirname(path), {
			recursive: true,
			mode: 448
		});
		const ownership = await acquireProcessLock(`${path}.lock`);
		const store = new LocalStore(path, ownership);
		try {
			try {
				const data = JSON.parse(await readFile(path, "utf8"));
				if (data.version !== 1 || !data.entries || typeof data.entries !== "object" || Array.isArray(data.entries)) throw new Error("本地状态库格式无效");
				for (const entry of Object.values(data.entries)) if (!entry || !("value" in entry) || entry.expires !== void 0 && !Number.isFinite(entry.expires)) throw new Error("本地状态库记录无效");
				store.entries = Object.assign(Object.create(null), data.entries);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await store.transaction(() => "OK", true);
			return store;
		} catch (error) {
			await ownership.release();
			throw error;
		}
	}
	transaction(action, forceWrite = false) {
		const result = this.queue.then(async () => {
			this.assertOwnership();
			this.changed = forceWrite;
			const previous = structuredClone(this.entries);
			const temp = `${this.path}.${randomUUID()}.tmp`;
			try {
				for (const [key, entry] of Object.entries(this.entries)) if (entry.expires !== void 0 && entry.expires <= Date.now()) {
					this.changed = true;
					Reflect.deleteProperty(this.entries, key);
				}
				const value = action();
				if (!this.changed) return value;
				await writeFile(temp, JSON.stringify({
					version: 1,
					entries: this.entries
				}), {
					mode: 384,
					flush: true
				});
				this.assertOwnership();
				await rename(temp, this.path);
				return value;
			} catch (error) {
				this.entries = previous;
				await unlink(temp).catch(() => void 0);
				throw error;
			}
		});
		this.queue = result.catch(() => void 0);
		return result;
	}
	read(action) {
		const result = this.queue.then(() => {
			this.assertOwnership();
			return action();
		});
		this.queue = result.catch(() => void 0);
		return result;
	}
	command([name, ...args]) {
		const key = String(args[0]);
		const candidate = this.entries[key];
		const entry = candidate?.expires !== void 0 && candidate.expires <= Date.now() ? void 0 : candidate;
		const list = () => entry?.value ?? [];
		const sorted = () => entry?.value ?? Object.create(null);
		switch (name) {
			case "get": return entry?.value ?? null;
			case "set": {
				if (args.includes("NX") && entry) return null;
				const ex = args.indexOf("EX");
				this.changed = true;
				this.entries[key] = {
					value: String(args[1]),
					...ex >= 0 ? { expires: Date.now() + Number(args[ex + 1]) * 1e3 } : {}
				};
				return "OK";
			}
			case "del": return args.reduce((count, item) => {
				const present = Boolean(this.entries[String(item)]);
				if (present) this.changed = true;
				Reflect.deleteProperty(this.entries, String(item));
				return count + Number(present);
			}, 0);
			case "expire":
				if (entry) {
					this.changed = true;
					entry.expires = Date.now() + Number(args[1]) * 1e3;
				}
				return Number(Boolean(entry));
			case "rpush":
				this.changed = true;
				this.entries[key] = {
					...entry,
					value: [...list(), String(args[1])]
				};
				return this.entries[key].value.length;
			case "lrange":
			case "ltrim": {
				const rows = list();
				const start = Number(args[1]);
				const end = Number(args[2]);
				const selected = rows.slice(Math.max(0, start < 0 ? rows.length + start : start), end < 0 ? rows.length + end + 1 : end + 1);
				if (name === "lrange") return selected;
				if (entry) {
					this.changed = true;
					entry.value = selected;
				}
				return "OK";
			}
			case "zadd": {
				const values = sorted();
				this.changed = true;
				values[String(args[2])] = Number(args[1]);
				this.entries[key] = {
					...entry,
					value: values
				};
				return 1;
			}
			case "zcard": return Object.keys(sorted()).length;
			case "zrem": {
				const values = sorted();
				if (Object.hasOwn(values, String(args[1]))) this.changed = true;
				Reflect.deleteProperty(values, String(args[1]));
				return 1;
			}
			case "zremrangebyscore": {
				const values = sorted();
				for (const [member, score] of Object.entries(values)) if (score >= Number(args[1]) && score <= Number(args[2])) {
					this.changed = true;
					Reflect.deleteProperty(values, member);
				}
				return 1;
			}
			case "zrangebyscore": return Object.entries(sorted()).filter(([, score]) => score >= Number(args[1]) && score <= Number(args[2])).sort((a, b) => a[1] - b[1]).map(([member]) => member).slice(Number(args[4] ?? 0), Number(args[4] ?? 0) + Number(args[5] ?? Infinity));
			case "scan": {
				const pattern = String(args[2]);
				if (!pattern.endsWith("*")) throw new Error("Unsupported local scan");
				return ["0", Object.keys(this.entries).filter((item) => item.startsWith(pattern.slice(0, -1)) && (this.entries[item].expires === void 0 || this.entries[item].expires > Date.now()))];
			}
			default: throw new Error(`Unsupported local command: ${name}`);
		}
	}
	get(key) {
		return this.read(() => this.command(["get", key]));
	}
	set(...args) {
		return this.transaction(() => this.command(["set", ...args]));
	}
	del(...keys) {
		return this.transaction(() => this.command(["del", ...keys]));
	}
	lrange(...args) {
		return this.read(() => this.command(["lrange", ...args]));
	}
	zrem(...args) {
		return this.transaction(() => this.command(["zrem", ...args]));
	}
	zrangebyscore(...args) {
		return this.read(() => this.command(["zrangebyscore", ...args]));
	}
	scan(...args) {
		return this.read(() => this.command(["scan", ...args]));
	}
	multi() {
		const commands = [];
		const chain = {
			zremrangebyscore: (...args) => {
				commands.push(["zremrangebyscore", ...args]);
				return chain;
			},
			zadd: (...args) => {
				commands.push(["zadd", ...args]);
				return chain;
			},
			zcard: (...args) => {
				commands.push(["zcard", ...args]);
				return chain;
			},
			expire: (...args) => {
				commands.push(["expire", ...args]);
				return chain;
			},
			rpush: (...args) => {
				commands.push(["rpush", ...args]);
				return chain;
			},
			ltrim: (...args) => {
				commands.push(["ltrim", ...args]);
				return chain;
			},
			exec: () => this.transaction(() => commands.map((command) => [null, this.command(command)]))
		};
		return chain;
	}
	eval(script, keyCount, ...args) {
		return this.transaction(() => {
			const name = /^-- agent-link:(\w+)/.exec(script)?.[1];
			const keys = args.slice(0, keyCount);
			const a = args.slice(keyCount);
			const get = (key) => this.command(["get", key]);
			const put = (key, value) => {
				this.command([
					"set",
					key,
					JSON.stringify(value)
				]);
			};
			const raw = get(keys[0]);
			const meta = name === "finalizeDedupe" || name === "releaseDedupe" || name === "memory" ? {} : JSON.parse(raw || "{}");
			const policy = {
				version: 2,
				chat: true,
				web: true,
				files: true,
				terminal: false
			};
			switch (name) {
				case "claimDisabledNotice": {
					let notice = raw ? JSON.parse(raw) : {
						epoch: a[0],
						count: 0
					};
					if (notice.epoch !== a[0]) notice = {
						epoch: a[0],
						count: 0
					};
					if (notice.count >= Number(a[1])) return 0;
					notice.count++;
					put(keys[0], notice);
					return 1;
				}
				case "finalizeDedupe":
					if (raw !== a[0]) return 0;
					this.command([
						"set",
						keys[0],
						a[1],
						"EX",
						a[2]
					]);
					return 1;
				case "releaseDedupe": return raw === a[0] ? this.command(["del", keys[0]]) : 0;
				case "touch": {
					const value = raw ? meta : JSON.parse(a[2]);
					if (a[3] !== "" && (!raw || value.generation !== Number(a[3]) || value.isolated !== true || value.transition)) return JSON.stringify(value);
					value.lastActivity = Number(a[0]);
					put(keys[0], value);
					this.command([
						"zadd",
						keys[1],
						a[0],
						a[1]
					]);
					return JSON.stringify(value);
				}
				case "setPolicy": {
					const value = raw ? meta : JSON.parse(a[1]);
					value.policy = JSON.parse(a[0]);
					put(keys[0], value);
					return null;
				}
				case "beginReset":
				case "beginPurge": {
					const transition = name === "beginReset" ? "resetting" : "purging";
					if (meta.transition === transition && typeof meta.operationId === "string") return JSON.stringify(meta);
					if (name === "beginReset") meta.generation = (Number(meta.generation) || 0) + 1;
					if (meta.policy?.version !== 1 && meta.policy?.version !== 2) meta.policy = policy;
					meta.lastActivity = Number(a[0]);
					meta.isolated = false;
					meta.transition = transition;
					meta.operationId = a[1];
					put(keys[0], meta);
					this.command([
						"zadd",
						keys[1],
						a[0],
						a[2]
					]);
					return JSON.stringify(meta);
				}
				case "completeReset":
					if (meta.transition !== "resetting" || meta.operationId !== a[0]) return 0;
					meta.isolated = true;
					delete meta.transition;
					delete meta.operationId;
					put(keys[0], meta);
					return 1;
				case "writeHistoryAnchor":
					if (meta.generation !== Number(a[0]) || meta.isolated !== true || meta.transition) return 0;
					this.command([
						"set",
						keys[1],
						a[1],
						"EX",
						a[2]
					]);
					return 1;
				case "appendPrivateTurn":
					if (meta.generation !== Number(a[0]) || meta.isolated !== true || meta.transition) return 0;
					this.command([
						"rpush",
						keys[1],
						a[1]
					]);
					this.command([
						"ltrim",
						keys[1],
						-Number(a[2]),
						-1
					]);
					this.command([
						"expire",
						keys[1],
						a[3]
					]);
					return 1;
				case "memory": {
					let notes = JSON.parse(raw || "[]");
					if (a[0] === "add") {
						if (notes.some((note) => note.text === a[1])) return JSON.stringify({
							status: "exists",
							notes
						});
						if (notes.length >= Number(a[4])) return JSON.stringify({
							status: "full",
							notes
						});
						notes.push({
							id: a[2],
							text: a[1],
							createdAt: Number(a[3])
						});
					} else if (a[0] === "replace") {
						const note = notes.find((item) => item.id === a[6]);
						if (!note) return JSON.stringify({
							status: "missing",
							notes
						});
						if (note.text !== a[7]) return JSON.stringify({
							status: "stale",
							notes
						});
						if (notes.some((item) => item.id !== a[6] && item.text === a[1])) return JSON.stringify({
							status: "duplicate",
							notes
						});
						note.text = a[1];
						note.createdAt = Number(a[3]);
					} else if (a[0] === "remove") {
						if (!notes.some((note) => note.id === a[1])) return JSON.stringify({
							status: "missing",
							notes
						});
						notes = notes.filter((note) => note.id !== a[1]);
					} else if (a[0] === "clear") notes = [];
					if (notes.length) this.command([
						"set",
						keys[0],
						JSON.stringify(notes),
						"EX",
						a[5]
					]);
					else this.command(["del", keys[0]]);
					return JSON.stringify({
						status: "ok",
						notes
					});
				}
				default: throw new Error("Unsupported local registry operation");
			}
		});
	}
};

export { LocalStore, getLocalStore };