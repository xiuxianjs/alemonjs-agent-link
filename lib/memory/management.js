import { getChatArchive } from "../history/store.js";
import { getMemoryStore, memoryTextKey as normalize } from "./store.js";
import { SessionRegistry } from "../state/registry.js";

// src/memory/management.ts
const synchronizeExplicitMemory = async (config, scope, userId) => {
	if (!scope.channelId.startsWith("private:")) return;
	const notes = await new SessionRegistry(config).privateMemories(scope.channelId);
	getMemoryStore(config).syncExplicit(scope, userId, notes);
};
const forgetMemory = async (config, scope, userId, id) => {
	const registry = new SessionRegistry(config);
	const store = getMemoryStore(config);
	await synchronizeExplicitMemory(config, scope, userId);
	const checkpoint = getChatArchive(config).latestSeq(scope);
	if (!id) {
		if (scope.channelId.startsWith("private:")) await registry.changePrivateMemory(scope.channelId, "clear");
		store.clear(scope, checkpoint);
		return "ok";
	}
	const item = store.get(scope, id);
	if (item?.origin === "explicit") {
		const notes = await registry.privateMemories(scope.channelId);
		for (const note of notes.filter((entry) => normalize(entry.text) === normalize(item.text))) if ((await registry.changePrivateMemory(scope.channelId, "remove", note.id)).status !== "ok") throw new Error("明确资料删除未完成。");
	}
	return store.forget(scope, id, checkpoint) ? "ok" : "missing";
};

export { forgetMemory, synchronizeExplicitMemory };