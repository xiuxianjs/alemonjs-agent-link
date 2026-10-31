import { AdminInputError } from "../panel/admin-error.js";
import { validatePersonaDetails } from "../companion/persona-details.js";
import { resolveIntelligenceAccess } from "./intelligence.js";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// src/agent/scoped-persona.ts
const pathFor = (config, identity) => {
	if (!identity.platform || !identity.channelId || !identity.userId) throw new Error("无法确定会话");
	return join(dirname(config.workspaceRoot), "scoped-personas", createHash("sha256").update(JSON.stringify([identity.platform, identity.channelId])).digest("hex") + ".json");
};
const readScopedPersona = (config, identity) => {
	try {
		return validatePersonaDetails(JSON.parse(readFileSync(pathFor(config, identity), "utf8")));
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw new AdminInputError("专属人设读取失败，请检查存储文件；未覆盖原内容");
	}
};
const saveScopedPersona = async (config, identity, details, expected) => {
	if (!(await resolveIntelligenceAccess(identity, config)).canEdit) throw new Error("本人需绑定 Key；群内需本群绑定 Key 并由管理员编辑。");
	const value = validatePersonaDetails(details);
	const path = pathFor(config, identity);
	if (expected !== void 0) {
		const canonical = (value) => JSON.stringify(Object.entries(validatePersonaDetails(value)).sort(([a], [b]) => a.localeCompare(b)));
		if (canonical(readScopedPersona(config, identity)) !== canonical(expected)) throw new AdminInputError("人设已被其他操作修改，请重新读取后保存");
	}
	mkdirSync(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temp = path + "." + process.pid + ".tmp";
	writeFileSync(temp, JSON.stringify(value), { mode: 384 });
	renameSync(temp, path);
};

export { readScopedPersona, saveScopedPersona };