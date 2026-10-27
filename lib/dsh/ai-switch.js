import { DSHError } from "./errors.js";
import { getAppConfig } from "alemonjs";

// src/dsh/ai-switch.ts
const defaultDisabledReason = "AI 暂时关闭，请稍后再来。";
const aiDisabledMessage = (config) => config.aiDisabledReason?.trim() || "AI 暂时关闭，请稍后再来。";
const assertAIEnabled = (snapshot) => {
	const current = getAppConfig().value;
	const disabled = current.aiEnabled === false ? current : snapshot?.aiEnabled === false ? snapshot : void 0;
	if (disabled) throw new DSHError("disabled", aiDisabledMessage(disabled));
};
const setAIEnabled = (owner, enabled, reason = "") => {
	if (!owner) throw new Error("只有机器人主人可以设置 AI 总开关。");
	if (reason.length > 500) throw new Error("关闭原因最多 500 字。");
	const app = getAppConfig();
	if (!app.name || !app.path) throw new Error("无法确认配置文件位置，未修改 AI 开关。");
	const aiDisabledReason = enabled ? app.value.aiDisabledReason || "" : reason.trim() || "AI 暂时关闭，请稍后再来。";
	app.saveValue({
		...app.value,
		aiEnabled: enabled,
		aiDisabledReason
	});
	if (app.value.aiEnabled !== enabled || app.value.aiDisabledReason !== aiDisabledReason) throw new Error("AI 开关保存失败。");
	return enabled ? "AI 请求已全局开启。" : `AI 请求已全局关闭。\n原因：${aiDisabledReason}\n主人可发送 /开启 恢复。`;
};

export { aiDisabledMessage, assertAIEnabled, defaultDisabledReason, setAIEnabled };