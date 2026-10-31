import { getPersonaStore } from "../companion/personas.js";

// src/modules/persona.ts
const personaModule = (config) => ({
	id: "persona",
	name: "人格",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		const store = getPersonaStore(config);
		api.on("context", () => "人物形象请用 persona_appearance：可先用list查看已有版本；用户问你长什么样时从当前人设形象库取原图，用户要换装时从形象库取参考图二创，不以文字生图替代。库为空就说明需上传；不将未送达图片称为已送达。");
		api.on("system", (base, context) => context.platform && context.channelId ? store.systemPrompt({
			...config,
			defaultSystemPrompt: base
		}, context) : base);
	}
});

export { personaModule };