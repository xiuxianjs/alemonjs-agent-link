import { ProductSettingsFile } from "./product-settings-file.js";
import { getConfig } from "alemonjs";
import { access } from "node:fs/promises";

// src/panel/admin-panel.ts
let store;
const initializeAdminPanel = async () => {
	const path = getConfig().path;
	if (!path) throw new Error("未找到当前配置文件");
	await access(path);
	store = new ProductSettingsFile(path);
};
const disposeAdminPanel = () => {
	store = void 0;
};
const getAdminStore = () => {
	if (!store) throw new Error("管理服务未就绪");
	return store;
};

export { disposeAdminPanel, getAdminStore, initializeAdminPanel };