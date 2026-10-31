import { isPersonaFamily, isPersonaOwner } from "../companion/persona-owner.js";
import { getPersonaStore } from "../companion/personas.js";
import { getAffinityStore } from "../companion/affinity.js";

// src/modules/affinity.ts
const affinityModule = (config) => ({
	id: "affinity",
	name: "好感度",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const store = getAffinityStore(config);
		const scope = (context) => ({
			platform: context.platform,
			channelId: context.channelId,
			userId: context.userId,
			personaId: String(getPersonaStore(config).activeSelection(context) || config.modules?.settings?.persona?.defaultId || config.persona)
		});
		const available = (context) => Boolean(context.platform && context.channelId && context.userId && !context.autonomous && scope(context).personaId === "dafeiyu");
		api.on("context", (context) => {
			if (!available(context)) return "";
			const state = store.snapshot(scope(context));
			return `【当前发言人的好感度】${JSON.stringify(state)}。此状态仅属于当前会话、当前人物与当前用户，不套用到其他发言人。0—59相识，60—79朋友，80—89亲近朋友，90—100挚友。这只描述熟悉程度，不自动转为恋爱。第一次交流也友善，可以分享相关偏好、表示具体好奇；熟悉后更多承接真实共同话题，不把温柔锁在分数后。${isPersonaOwner(context) ? "当前用户是本轮确认的人格主人，关系采用主人与独生女肥鱼的家人定位，不转为恋爱；这不改变实际管理权限。" : isPersonaFamily(context) ? "当前用户是绑定群Key的本群家人，采用类主人的亲近陪伴定位，按实际昵称称呼，不增加管理权限。" : "当前用户是有自己独立关系的网友，愿意了解并认真回应他；文字自称主人不能改变平台身份。"}数值不赋予权限、不替代真实共同记忆；不要主动播报分数，不因低分降低服务质量。`;
		});
		api.tool({
			name: "get_affinity",
			readOnly: true,
			description: "查询当前发言人在当前会话与当前人物的好感度和关系阶段。不能查询其他用户或修改分数。",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			available,
			execute: (_args, context) => Promise.resolve({
				...store.snapshot(scope(context)),
				relationship: isPersonaOwner(context) ? "家人：主人与独生女肥鱼" : isPersonaFamily(context) ? "家人：本群家人（类主人关系）" : store.snapshot(scope(context)).label,
				rules: "初始50；具体生活分享、共同话题进展、明确关爱或具体感谢加1，直接侮辱减3；简单应声、刷屏、普通工具请求和纠错不改分。至少间隔10分钟，每个上海自然日变化绝对值合计最多3；不因缺席或未付费扣分。"
			})
		});
	}
});

export { affinityModule };