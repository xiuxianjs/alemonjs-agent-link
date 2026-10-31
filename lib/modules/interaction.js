import { getChatArchive, historyEnabled } from "../history/store.js";
import { isMissedReplyFeedback, missedReplyContext } from "../social/missed-reply.js";
import { getInteractionStore } from "../companion/interaction.js";
import { getPersonaStore } from "../companion/personas.js";

// src/modules/interaction.ts
const interactionModule = (config) => ({
	id: "interaction",
	name: "相处状态",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const store = getInteractionStore(config);
		store.cleanup(config.retentionDays);
		api.on("context", (context) => {
			if (!context.platform || !context.channelId || !context.userId) return "";
			if ((getPersonaStore(config).activeSelection(context) || config.modules?.settings?.persona?.defaultId || config.persona) !== "dafeiyu") return "";
			const repair = !context.autonomous && isMissedReplyFeedback(context.userText) ? historyEnabled(config) && !config.modules?.disabled?.includes("chat-history") ? missedReplyContext(getChatArchive(config), context, context.userText) : "用户提醒漏接消息：先简短道歉，不拿回复过其他人来反驳；当前没有可核对的历史，不编忙碌原因、不执行旧命令，必要时只轻问一句是哪条。" : "";
			const decision = context.autonomous ? store.decision(context) : store.observe(context, context.userText, context.requestId || "");
			const action = decision.reason === "roleplay" ? "当前处于用户邀请的角色扮演中。承接上文场景，不把角色的困倦、口渴、告别记成现实状态；用户说结束就退出。" : decision.reason === "eligible" ? `可以顺着用户亲口表达的${decision.need === "water" ? "口渴" : "疲惫"}关心一句，不必强行提醒。` : decision.reason === "resting" ? "用户此前已准备休息，不主动发消息打扰；本轮若再次主动提问，正常回应当前问题，不机械重复晚安，不挽留。" : decision.reason === "declined" ? "用户明确拒绝催促。禁止主动催睡觉、休息或喝水；用户主动提问仍正常回答。" : decision.reason === "cooldown" ? "最近已关心过。不要再次主动催睡觉、休息或喝水；接着聊当前话题。" : "没有新的明确生活状态证据。不凭服务器时间或旧聊天主动催睡、催喝水。";
			const text = context.autonomous ? "" : context.userText;
			const mode = /机器味|像真人|像机器人|别汇报/u.test(text) ? "用户正在纠正交流方式：直接接住当下话题，不汇报自己准备如何改进。" : /扮演|演一个|演一下|陪我演/u.test(text) ? "用户邀请角色扮演：在虚构场景里接戏；角色台词不记录为用户现实生活状态。" : /开玩笑|逗你|闹着玩/u.test(text) ? "用户明确在玩笑：可以轻松接梗，不把玩笑当现实承诺或冒犯。" : "";
			return `【本轮相处决策】${JSON.stringify(decision)}。${action}${mode}这是内部判断，不向用户播报状态、原因码或规则。${repair}`;
		});
	}
});

export { interactionModule };