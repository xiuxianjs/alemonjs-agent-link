import { DSHError } from "../dsh/errors.js";
import { balanceWasConfirmed, confirmBalance } from "./balance-scope.js";
import { budgetRedis, getBudgetScope } from "../billing/budget.js";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { getConfigValue } from "alemonjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// src/credentials/personal.ts
const isPersonalKeyCommand = (text) => /^\/(?:apikey|个人密钥|群密钥|groupapikey)(?:\s|$)/iu.test(String(text ?? "").trimStart());
const keyFile = () => resolve(process.env.AGENT_LINK_PERSONAL_KEY_FILE || ".data/agent-link/personal-key.key");
const keyFor = (scope) => {
	if (!scope.platform || !scope.userId || scope.channelId !== `private:${JSON.stringify([scope.platform, scope.userId])}`) throw new DSHError("budget", "个人 API Key 只能在本人私聊中管理和使用。");
	return `data:{agent-link-personal-keys}:v1:${createHash("sha256").update(JSON.stringify([scope.platform, scope.userId])).digest("hex")}`;
};
const encryptionKey = async (create = false) => {
	if (create) {
		await mkdir(dirname(keyFile()), {
			recursive: true,
			mode: 448
		});
		await writeFile(keyFile(), randomBytes(32), {
			flag: "wx",
			mode: 384
		}).catch((error) => {
			if (error.code !== "EEXIST") throw error;
		});
	}
	try {
		const key = await readFile(keyFile());
		if (key.length !== 32) throw new Error("key");
		return key;
	} catch (error) {
		if (!create && error.code === "ENOENT") return null;
		throw new DSHError("budget", "个人密钥存储不可用，请联系主人检查。");
	}
};
const recordFor = async (scope) => {
	const key = keyFor(scope);
	const raw = await (await budgetRedis()).get(key);
	return raw ? JSON.parse(raw) : null;
};
const claimPersonalKeyCommand = async (scope, messageId) => {
	if (!messageId) throw new DSHError("budget", "缺少消息编号，请重新发送个人密钥管理指令。");
	const command = createHash("sha256").update(messageId).digest("hex");
	return await (await budgetRedis()).set(`${keyFor(scope)}:command:${command}`, "1", "EX", 2764800, "NX") === "OK";
};
const encryptStoredKey = async (storageKey, apiKey) => {
	const key = await encryptionKey(true);
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(storageKey));
	const data = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
	return Buffer.concat([
		iv,
		cipher.getAuthTag(),
		data
	]).toString("base64");
};
const bindPersonalKey = async (scope, apiKey) => {
	const storageKey = keyFor(scope);
	if (!/^sk-[A-Za-z0-9_-]{8,240}$/u.test(apiKey)) throw new DSHError("budget", "Key 格式无效，请使用 DeepSeek 官方 API Key。");
	const encrypted = await encryptStoredKey(storageKey, apiKey);
	await (await budgetRedis()).set(storageKey, JSON.stringify({
		encrypted,
		enabled: true,
		revision: randomUUID(),
		reason: ""
	}));
};
const personalKeyStatus = async (scope) => {
	const value = await recordFor(scope);
	return {
		bound: Boolean(value),
		enabled: value?.enabled === true,
		reason: value?.reason || ""
	};
};
/**
* 本人私聊是否绑定了已启用的个人 Key，用于"自带 Key 拉满"的权益判断。
* 从未绑定过个人 Key 的部署不因此新增 Redis 依赖。
*/
const personalKeyEntitled = async (target) => {
	if (!target.platform || !target.userId) return false;
	if (!await encryptionKey() && !getConfigValue()?.db?.redis) return false;
	const channelId = `private:${JSON.stringify([target.platform, target.userId])}`;
	return (await recordFor({
		platform: target.platform,
		channelId,
		userId: target.userId
	}))?.enabled === true;
};
const updatePersonalKey = async (scope, action, revision) => {
	const result = await (await budgetRedis()).eval(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if ARGV[2] ~= '' and value.revision ~= ARGV[2] then return 0 end
if ARGV[1] == 'remove' then redis.call('DEL', KEYS[1]); return 1 end
value.enabled = ARGV[1] == 'enable'
value.reason = ARGV[2] ~= '' and 'balance' or (value.enabled and '' or 'manual')
value.revision = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(value))
return 1`, 1, keyFor(scope), action, revision || "", randomUUID());
	return Number(result) === 1;
};
const getPersonalCredential = async () => {
	const scope = getBudgetScope();
	if (!scope?.channelId.startsWith("private:")) return null;
	const key = await encryptionKey();
	if (!key && !getConfigValue()?.db?.redis) return null;
	const value = await recordFor(scope);
	if (value?.enabled !== true) return null;
	if (!key) throw new DSHError("budget", "个人密钥加密文件缺失，请联系主人恢复或重新绑定。");
	return decryptStoredKey(keyFor(scope), value, scope, key);
};
const decryptStoredKey = (storageKey, value, scope, key) => {
	try {
		const bytes = Buffer.from(value.encrypted, "base64");
		const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
		decipher.setAuthTag(bytes.subarray(12, 28));
		decipher.setAAD(Buffer.from(storageKey));
		return {
			apiKey: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
			revision: value.revision,
			scope
		};
	} catch {
		throw new DSHError("budget", "个人密钥无法解密，请重新绑定。");
	}
};
const checkCredentialBalance = async (credential, disable, latestCredential, signal) => {
	if (!credential) return null;
	signal?.throwIfAborted();
	const balanceId = createHash("sha256").update(JSON.stringify([
		credential.scope.platform,
		credential.scope.channelId,
		credential.scope.channelId.startsWith("private:") ? credential.scope.userId : "",
		credential.revision,
		credential.apiKey
	])).digest("hex");
	if (balanceWasConfirmed(balanceId)) {
		const latest = await latestCredential();
		signal?.throwIfAborted();
		if (latest?.revision !== credential.revision) throw new DSHError("budget", "绑定 Key 设置已变更，请重新发送请求。");
		return credential;
	}
	let response;
	try {
		response = await fetch("https://api.deepseek.com/user/balance", {
			headers: { Authorization: `Bearer ${credential.apiKey}` },
			redirect: "error",
			signal: AbortSignal.any([AbortSignal.timeout(5e3), ...signal ? [signal] : []])
		});
	} catch {
		signal?.throwIfAborted();
		throw new DSHError("budget", "绑定 Key 余额查询暂时失败，未切换到机器人额度，请稍后再试。");
	}
	if (!response.ok && response.status !== 402) {
		await response.body?.cancel();
		throw new DSHError("budget", "绑定 Key 余额查询失败，请检查 Key 或稍后重试；未切换到机器人额度。");
	}
	let available = false;
	if (response.status !== 402) {
		const reader = response.body?.getReader();
		let body = "";
		try {
			if (!reader) throw new Error("body");
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				body += Buffer.from(part.value).toString("utf8");
				if (Buffer.byteLength(body) > 16384) throw new Error("body too large");
			}
			available = JSON.parse(body).is_available;
		} catch {
			available = void 0;
		} finally {
			await reader?.cancel().catch(() => void 0);
		}
	} else await response.body?.cancel();
	if (available === false) {
		if (!await disable(credential)) throw new DSHError("budget", "绑定 Key 设置已变更，请重新发送请求。");
		return null;
	}
	if (available !== true) throw new DSHError("budget", "绑定 Key 余额返回格式无效，未切换到机器人额度。");
	const latest = await latestCredential();
	signal?.throwIfAborted();
	if (latest?.revision !== credential.revision) throw new DSHError("budget", "绑定 Key 设置已变更，请重新发送请求。");
	confirmBalance(balanceId);
	return credential;
};
const checkedPersonalCredential = async (signal) => checkCredentialBalance(await getPersonalCredential(), (credential) => updatePersonalKey(credential.scope, "disable", credential.revision), getPersonalCredential, signal);

export { bindPersonalKey, checkCredentialBalance, checkedPersonalCredential, claimPersonalKeyCommand, decryptStoredKey, encryptStoredKey, encryptionKey, getPersonalCredential, isPersonalKeyCommand, personalKeyEntitled, personalKeyStatus, updatePersonalKey };