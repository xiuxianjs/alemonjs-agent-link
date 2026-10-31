// src/memory/save-intent.ts
/** Recognize a current save request, never a quoted instruction or retrieval question. */
const requestedMemorySave = (text) => {
	const value = text.replace(/```[\s\S]*?(?:```|$)/gu, " ").replace(/“[^”]*(?:”|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|‘[^’]*(?:’|$)|"[^"\n]*"|`[^`\n]*`|(?<![\p{L}\p{N}])'[^']*'/gu, " ").trim().replace(/^(?:大肥鱼|大肥鱼|肥鱼|deepseek|dsh)[，,：:\s]*/iu, "");
	if (/^(?:如果|假如|比如|例如|他说|她说|有人说|请解释|解释|怎么|如何|怎样|为什么)/u.test(value)) return false;
	if (/(?:别|不要|不准|无需|不用|不必|不需要|不想|没让|没有让).{0,8}(?:记住|记下来|记一下|帮我记)|do not remember|don.t remember/iu.test(value)) return false;
	if (/^(?:记住|记下来|记一下).*(?:了吗|了么|了没|没有)[？?。！!]*$/u.test(value)) return false;
	if (/^(?:记住|remember)\s*(?:是什么意思|什么意思|有什么用|怎么用|这个词(?:是什么意思|怎么翻译|怎么用))/iu.test(value)) return false;
	if (/^(?:do|did|can|could|would)\s+you\s+(?:still\s+)?remember\s+(?:what|when|where|who|how|whether)\b/iu.test(value)) return false;
	return value.split(/[，,。；;！!\n]/u).map((item) => item.trim()).some((clause) => /^(?:(?:请|麻烦你?|拜托你?|以后请|以后要|以后)\s*)?(?:(?:帮我|替我)\s*)?(?:记住|记下来|记一下|记着|记好)/u.test(clause) || /^(?:你)?(?:能不能|可不可以|可以|能)(?:帮我|替我)(?:记住|记下来|记一下)/u.test(clause) || /^(?:请)?(?:帮我|替我)记(?=[:：\s我这])/u.test(clause) || /(?:帮我|替我)(?:记住|记下来|记一下|记着|记好)[？?]*$/u.test(clause) || /^(?:(?:please|can you|could you)(?: please)?\s+)?(?:remember\b|save\b.{0,40}\bmemor(?:y|ies)\b)/iu.test(clause));
};

export { requestedMemorySave };