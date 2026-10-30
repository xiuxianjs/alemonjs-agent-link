import { parseAds } from "../ads/config.js";
import { getGroupChatPolicy } from "../social/group-policy.js";
import { resolveDSHConfig } from "../dsh/config.js";
import { getMediaConfig } from "../media/config.js";
import { resolveOneBotConfig } from "../onebot/config.js";
import { getModuleConfig } from "../agent/modules.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

// src/panel/product-settings-file.ts
const hiddenSecret = "__AGENTLINK_KEEP_SECRET__";
const maskKey = randomBytes(32);
const secretMarker = (value) => hiddenSecret + createHmac("sha256", maskKey).update(JSON.stringify(value)).digest("hex");
const secretKey = /^key$|api.?key|secret|password|token|authorization|master_key|bot_key/i;
const revision = (text) => createHash("sha256").update(text).digest("hex");
const parse$1 = (source) => {
	const doc = parseDocument(source);
	if (doc.errors.length || !isMap(doc.contents)) throw new Error("配置必须是有效的 YAML 对象");
	doc.toJS({ maxAliasCount: 100 });
	return doc;
};
const validateConfiguration = (source, path) => {
	const value = parse$1(source).toJS({ maxAliasCount: 100 });
	const raw = value["alemonjs-agent-link"] ?? {};
	const config = resolveDSHConfig(raw, {
		configPath: path,
		hasRedis: Boolean(value.db?.redis)
	});
	getGroupChatPolicy(raw.groupChat);
	getMediaConfig(raw);
	parseAds(raw.ads);
	getModuleConfig(config);
	if (config.transport === "onebot") resolveOneBotConfig(value);
	if (raw.budget?.enabled && !value.db?.redis) throw new Error("启用预算账本需要配置 db.redis");
	return config;
};
function redact(source) {
	const doc = parse$1(JSON.stringify(parse$1(source).toJS({ maxAliasCount: 100 })));
	const visit = (node, sensitive = false) => {
		if (isMap(node)) node.items.forEach((pair) => {
			const key = String(pair.key.value);
			if (["keys", "modelPool"].includes(key) && isSeq(pair.value)) pair.value.items.forEach((item) => visit(item, sensitive || isScalar(item)));
			else visit(pair.value, sensitive || secretKey.test(key));
		});
		else if (isSeq(node)) node.items.forEach((item) => visit(item, sensitive));
		else if (isScalar(node) && sensitive && node.value) node.value = secretMarker(node.value);
	};
	visit(doc.contents);
	return JSON.stringify(doc.toJS({ maxAliasCount: 100 }), null, 2);
}
var ProductSettingsFile = class {
	path;
	busy = false;
	constructor(path) {
		this.path = path;
	}
	async read() {
		const source = await readFile(this.path, "utf8");
		const app = parse$1(source).toJS({ maxAliasCount: 100 })["alemonjs-agent-link"] ?? {};
		return {
			source: redact(JSON.stringify({ "alemonjs-agent-link": app })),
			revision: revision(source)
		};
	}
	async prepare(source, expected) {
		const original = await readFile(this.path, "utf8");
		if (revision(original) !== expected) throw new Error("配置已被其他操作修改，请重新读取后再保存");
		const doc = parse$1(source);
		if (!isMap(doc.contents) || doc.contents.items.some((pair) => String(pair.key.value) !== "alemonjs-agent-link")) throw new Error("只能修改 AgentLink 配置");
		const before = parse$1(original);
		const secrets = /* @__PURE__ */ new Map();
		const collect = (node, sensitive = false) => {
			if (isMap(node)) node.items.forEach((pair) => {
				const key = String(pair.key.value);
				if (["keys", "modelPool"].includes(key) && isSeq(pair.value)) pair.value.items.forEach((item) => collect(item, sensitive || isScalar(item)));
				else collect(pair.value, sensitive || secretKey.test(key));
			});
			else if (isSeq(node)) node.items.forEach((item) => collect(item, sensitive));
			else if (isScalar(node) && sensitive && node.value) secrets.set(secretMarker(node.value), node.value);
		};
		collect(parse$1(JSON.stringify(before.toJS({ maxAliasCount: 100 }))).contents);
		const restore = (node, path = []) => {
			if (isMap(node)) node.items.forEach((pair) => restore(pair.value, [...path, String(pair.key.value)]));
			else if (isSeq(node)) node.items.forEach((item, index) => restore(item, [...path, index]));
			else if (isScalar(node) && typeof node.value === "string" && node.value.startsWith("__AGENTLINK_KEEP_SECRET__")) {
				const value = secrets.get(node.value);
				if (value === void 0) throw new Error("新配置不能使用未修改密钥占位符");
				node.value = value;
			}
		};
		restore(doc.contents);
		const merge = (old, next) => {
			if (isMap(old) && isMap(next)) {
				old.items = old.items.filter((pair) => next.has(String(pair.key.value)));
				next.items.forEach((pair) => {
					const key = String(pair.key.value);
					const prior = old.get(key, true);
					old.set(key, prior ? merge(prior, pair.value) : pair.value);
				});
				return old;
			}
			if (isScalar(old) && isScalar(next)) {
				old.value = next.value;
				return old;
			}
			return next;
		};
		const appKey = "alemonjs-agent-link";
		const nextApp = doc.get(appKey, true);
		if (!isMap(nextApp)) throw new Error("AgentLink 配置必须为对象");
		const previousApp = before.get(appKey, true);
		before.set(appKey, previousApp ? merge(previousApp, nextApp) : nextApp);
		const result = before.toString();
		validateConfiguration(result, this.path);
		return {
			original,
			result
		};
	}
	async save(source, expected) {
		if (this.busy) throw new Error("正在保存配置，请稍后重试");
		this.busy = true;
		const temp = this.path + "." + randomUUID() + ".tmp";
		try {
			const { original, result } = await this.prepare(source, expected);
			const directory = join(dirname(this.path), ".agent-link-config-history");
			await mkdir(directory, {
				recursive: true,
				mode: 448
			});
			await writeFile(join(directory, Date.now() + "-" + randomUUID() + ".yaml"), JSON.stringify({ "alemonjs-agent-link": parse$1(original).toJS()["alemonjs-agent-link"] ?? {} }, null, 2), {
				mode: 384,
				flag: "wx"
			});
			await writeFile(temp, result, {
				mode: 384,
				flag: "wx"
			});
			if (revision(await readFile(this.path, "utf8")) !== expected) throw new Error("配置已变化，保存已取消");
			await rename(temp, this.path);
			return this.read();
		} finally {
			this.busy = false;
			await unlink(temp).catch(() => void 0);
		}
	}
};

export { ProductSettingsFile, hiddenSecret, validateConfiguration };