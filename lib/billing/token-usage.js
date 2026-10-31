import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { logger } from "alemonjs";

// src/billing/token-usage.ts
const databases = /* @__PURE__ */ new Map();
const usageDay = (now = Date.now()) => new Date(now + 288e5).toISOString().slice(0, 10);
const tokenKeyId = (url, key) => createHash("sha256").update(url.origin + "\n" + key).digest("hex");
const database = (root) => {
	const path = join(root, "token-usage.sqlite");
	let db = databases.get(path);
	if (!db) {
		mkdirSync(root, {
			recursive: true,
			mode: 448
		});
		db = new DatabaseSync(path);
		chmodSync(path, 384);
		db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS token_labels(key_id TEXT PRIMARY KEY,label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS token_events(id TEXT PRIMARY KEY, key_id TEXT NOT NULL, day TEXT NOT NULL, known INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS token_totals(period TEXT NOT NULL,key_id TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,known INTEGER NOT NULL DEFAULT 0,input INTEGER NOT NULL DEFAULT 0,output INTEGER NOT NULL DEFAULT 0,cached INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(period,key_id));`);
		databases.set(path, db);
	}
	return db;
};
const periods = (day) => [
	day,
	day.slice(0, 7),
	day.slice(0, 4),
	"all"
];
const beginTokenUsage = (root, keyId, now = Date.now()) => {
	const db = database(root), id = randomUUID(), day = usageDay(now);
	db.exec("BEGIN IMMEDIATE");
	try {
		db.prepare("INSERT INTO token_events(id,key_id,day) VALUES(?,?,?)").run(id, keyId, day);
		for (const period of periods(day)) for (const key of [keyId, "*"]) db.prepare("INSERT INTO token_totals(period,key_id,requests) VALUES(?,?,1) ON CONFLICT(period,key_id) DO UPDATE SET requests=requests+1").run(period, key);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return (value) => {
		const usage = value;
		const input = usage?.prompt_tokens, output = usage?.completion_tokens;
		if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return;
		const rawCached = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0;
		const cached = Number.isSafeInteger(rawCached) && rawCached >= 0 ? Math.min(input, rawCached) : 0;
		db.exec("BEGIN IMMEDIATE");
		try {
			if (db.prepare("UPDATE token_events SET known=1 WHERE id=? AND known=0").run(id).changes) for (const period of periods(day)) for (const key of [keyId, "*"]) db.prepare("UPDATE token_totals SET known=known+1,input=input+?,output=output+?,cached=cached+? WHERE period=? AND key_id=?").run(input, output, cached, period, key);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
};
const readTokenUsage = (root, period = usageDay()) => {
	if (!(period === "all" || /^\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/u.test(period))) throw new Error("统计日期无效");
	if (period.length === 10 && (/* @__PURE__ */ new Date(period + "T00:00:00Z")).toISOString().slice(0, 10) !== period) throw new Error("统计日期无效");
	const rows = database(root).prepare("SELECT key_id,requests,known,input,output,cached FROM token_totals WHERE period=? ORDER BY input+output DESC").all(period);
	const labels = new Map(database(root).prepare("SELECT key_id,label FROM token_labels").all().map((row) => [row.key_id, row.label]));
	return {
		period,
		timezone: "Asia/Shanghai",
		total: rows.find((row) => row.key_id === "*") || {
			requests: 0,
			known: 0,
			input: 0,
			output: 0,
			cached: 0
		},
		keys: rows.filter((row) => row.key_id !== "*").map((row) => ({
			...row,
			label: labels.get(row.key_id) || "授权或其他 Key"
		}))
	};
};
const rememberTokenKey = (root, id, label) => {
	database(root).prepare("INSERT INTO token_labels(key_id,label) VALUES(?,?) ON CONFLICT(key_id) DO UPDATE SET label=excluded.label").run(id, label);
};
const tokenUsageFetch = async (config, url, init) => {
	const headers = new Headers(init.headers);
	const key = headers.get("authorization")?.replace(/^Bearer\s+/iu, "") || headers.get("x-dsh-auth-token");
	let settle = () => {};
	if (key) try {
		const root = dirname(config.dshHomeRoot), id = tokenKeyId(url, key);
		const labels = config.modelPool?.endpoints.filter((endpoint) => endpoint.apiKey === key && new URL(endpoint.baseUrl).origin === url.origin).map((endpoint) => endpoint.id);
		if (labels?.length) rememberTokenKey(root, id, labels.join("、"));
		settle = beginTokenUsage(root, id);
	} catch {
		logger.warn("Token 用量账本写入失败");
	}
	try {
		const body = JSON.parse(String(init.body));
		if (body.stream) init = {
			...init,
			body: JSON.stringify({
				...body,
				stream_options: {
					...body.stream_options,
					include_usage: true
				}
			})
		};
	} catch {}
	const response = await fetch(url, init);
	if (!response.body) return response;
	const streaming = response.headers.get("content-type")?.includes("text/event-stream");
	if (!streaming) {
		const reader = response.clone().body.getReader();
		const parts = [];
		let bytes = 0;
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.length;
				if (bytes > 8388608) {
					reader.cancel();
					return response;
				}
				parts.push(chunk.value);
			}
			settle(JSON.parse(Buffer.concat(parts).toString("utf8"))?.usage);
		} catch {}
		return response;
	}
	const decoder = new TextDecoder();
	let buffer = "", usage;
	const parse = (text) => {
		try {
			const data = JSON.parse(text);
			if (data.usage) usage = data.usage;
		} catch {}
	};
	const inspect = (text) => {
		buffer += text;
		if (streaming) {
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (line.startsWith("data:")) parse(line.slice(5).trim());
			}
		}
		if (buffer.length > 8388608) buffer = "";
	};
	const reader = response.body.getReader();
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		inspect(decoder.decode());
		if (buffer.trim().startsWith("data:")) parse(buffer.trim().slice(5).trim());
		try {
			settle(usage);
		} catch {
			logger.warn("Token 用量结算失败");
		}
	};
	const body = new ReadableStream({
		async pull(controller) {
			try {
				const chunk = await reader.read();
				if (finished) return;
				if (chunk.done) {
					finish();
					controller.close();
					reader.releaseLock();
				} else {
					inspect(decoder.decode(chunk.value, { stream: true }));
					controller.enqueue(chunk.value);
				}
			} catch (error) {
				if (finished) return;
				finish();
				controller.error(error);
				reader.releaseLock();
			}
		},
		async cancel(reason) {
			finish();
			try {
				await reader.cancel(reason);
			} finally {
				reader.releaseLock();
			}
		}
	}, { highWaterMark: 0 });
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
};

export { beginTokenUsage, readTokenUsage, rememberTokenKey, tokenKeyId, tokenUsageFetch, usageDay };