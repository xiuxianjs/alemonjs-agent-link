import { normalizeHobbies } from "../companion/hobbies.js";
import { browseWindow } from "./browse-schedule.js";

// src/proactive/reading-settings.ts
/** Global hobby controls may stop reading; a private override may always opt out. */
const readingSettings = (config, store, scope) => {
	const raw = config.modules?.settings?.bili || {};
	const managed = config.modules?.settings?.hobbies?.autonomous !== void 0;
	const hobbies = normalizeHobbies(config.modules?.settings?.hobbies);
	const enabled = managed ? hobbies.enabled && hobbies.autonomous && hobbies.bilibili && !config.modules?.disabled?.includes("hobbies") : raw.dailyBrowse === true;
	const scoped = store.dailyBrowseSettings(scope, enabled, browseWindow(raw.dailyBrowseWindow));
	return {
		...scoped,
		managed,
		enabled: (!managed || enabled) && scoped.enabled
	};
};

export { readingSettings };