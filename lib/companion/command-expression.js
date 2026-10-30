import { getPersonaStore } from "./personas.js";

// src/companion/command-expression.ts
/** Fixed commands keep their authoritative facts; only their phrasing varies. */
const commandExpression = (config, scope, natural, concise) => {
	if (config.modules?.disabled?.includes("persona")) return concise;
	const store = getPersonaStore(config);
	const persona = store.selected(scope) || config.modules?.settings?.persona?.defaultId || config.persona;
	const mode = store.expressionMode(scope);
	return persona === "dafeiyu" && (mode === "活跃" || mode === "个性") ? natural : concise;
};
const commandMoodText = (value) => value >= 75 ? "现在心情不错，挺想聊两句的。" : value >= 45 ? "现在心情挺平和的。" : value >= 25 ? "现在有点低落，想慢慢聊。" : "现在有些疲惫，想安静一点。";

export { commandExpression, commandMoodText };