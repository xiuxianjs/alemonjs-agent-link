import { interruptAllProactive } from "../proactive/control.js";
import { getDSHConfig } from "../dsh/runtime-config.js";
import { AdminInputError } from "./admin-error.js";
import { normalizeHobbies } from "../companion/hobbies.js";
import { getProactiveStore } from "../proactive/store.js";
import { getAdminStore } from "./admin-panel.js";
import { getConfig } from "alemonjs";

// src/panel/hobbies.ts
const project = (snapshot) => ({
	revision: snapshot.revision,
	activities: getProactiveStore(getDSHConfig()).hobbyActivityStatus(),
	values: normalizeHobbies(JSON.parse(snapshot.source)["alemonjs-agent-link"]?.modules?.settings?.hobbies)
});
const readHobbies = async () => project(await getAdminStore().read());
const saveHobbies = async (input) => {
	const body = input;
	if (!body || typeof body.revision !== "string" || !body.revision || !body.values) throw new AdminInputError("无效的爱好设置");
	const values = normalizeHobbies(body.values);
	const store = getAdminStore();
	const snapshot = await store.read();
	if (snapshot.revision !== body.revision) throw new AdminInputError("配置已变化，请重新读取后再保存");
	const source = JSON.parse(snapshot.source);
	const app = source["alemonjs-agent-link"];
	app.modules ||= {};
	app.modules.settings ||= {};
	app.modules.settings.hobbies = values;
	const saved = await store.save(JSON.stringify(source), body.revision);
	getConfig().reload();
	interruptAllProactive();
	return project(saved);
};

export { readHobbies, saveHobbies };