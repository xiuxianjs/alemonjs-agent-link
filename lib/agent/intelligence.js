import { groupPolicy } from "../social/group-settings.js";
import { withBudgetScope } from "../billing/budget.js";
import { getPersonalCredential } from "../credentials/personal.js";
import { getGroupCredential } from "../credentials/group.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// src/agent/intelligence.ts
const intelligenceLevels = [
	"轻快",
	"标准",
	"深度",
	"专研"
];
const intelligenceProfiles = {
	轻快: {
		maxRounds: 2,
		maxContinuations: 0
	},
	标准: {
		maxRounds: 4,
		maxContinuations: 0
	},
	深度: {
		maxRounds: 8,
		maxContinuations: 1
	},
	专研: {
		maxRounds: 12,
		maxContinuations: 2
	}
};
const intelligenceAccess = (identity, bound, elevation = true) => ({
	entitled: identity.owner || bound && elevation,
	canEdit: identity.owner || bound && elevation && (identity.private || identity.admin === true),
	defaultLevel: identity.owner || bound && elevation ? "深度" : "标准"
});
const resolveIntelligenceAccess = async (identity, config) => {
	let bound = false;
	try {
		bound = Boolean(await withBudgetScope(identity, identity.private ? getPersonalCredential : getGroupCredential));
	} catch {}
	const elevation = identity.private || !config || groupPolicy(config, identity.channelId, identity.platform).boundKeyElevation !== false;
	return {
		...intelligenceAccess(identity, bound, elevation),
		bound
	};
};
const file = (config, identity) => {
	if (!identity.platform || !identity.channelId || !identity.userId) throw new Error("无法确定当前身份与会话");
	const id = createHash("sha256").update(JSON.stringify([identity.platform, identity.channelId])).digest("hex");
	return join(dirname(config.workspaceRoot), "intelligence", id + ".json");
};
const readIntelligenceLevel = (config, identity, entitled) => {
	if (!entitled) return void 0;
	try {
		const value = JSON.parse(readFileSync(file(config, identity), "utf8")).level;
		return intelligenceLevels.includes(value) ? value : void 0;
	} catch {
		return;
	}
};
const saveIntelligenceLevel = async (config, identity, level) => {
	if (!(await resolveIntelligenceAccess(identity, config)).canEdit) throw new Error("本人绑定 Key 后可设置；群内需本群绑定 Key 且由管理员设置。");
	if (level !== "默认" && !intelligenceLevels.includes(level)) throw new Error("请选择轻快、标准、深度、专研或默认");
	const path = file(config, identity);
	mkdirSync(dirname(path), {
		recursive: true,
		mode: 448
	});
	const temp = path + "." + process.pid + ".tmp";
	writeFileSync(temp, JSON.stringify({ level: level === "默认" ? null : level }), { mode: 384 });
	renameSync(temp, path);
};
const turnIntelligence = async (config, identity, text, autonomous = false) => {
	const access = await resolveIntelligenceAccess(identity, config);
	let level = readIntelligenceLevel(config, identity, access.entitled) || access.defaultLevel;
	const requested = text.match(/^\s*本次智能程度[：: ]+(轻快|标准|深度|专研)(?:\s|[，。]|$)/u)?.[1];
	if (requested && access.entitled && !autonomous) level = requested;
	if (autonomous) level = "轻快";
	return {
		level,
		...intelligenceProfiles[level],
		entitled: access.entitled
	};
};
const ownerTerminalAllowed = (identity, autonomous = false) => identity.owner && identity.private && !autonomous;
const reasoningParameters = (url, model, level) => {
	if (!level || url.hostname !== "api.deepseek.com" || !/^deepseek-(?:v4|flash|pro)/u.test(model)) return {};
	return { thinking: { type: ["深度", "专研"].includes(level) ? "enabled" : "disabled" } };
};

export { intelligenceAccess, intelligenceLevels, intelligenceProfiles, ownerTerminalAllowed, readIntelligenceLevel, reasoningParameters, resolveIntelligenceAccess, saveIntelligenceLevel, turnIntelligence };