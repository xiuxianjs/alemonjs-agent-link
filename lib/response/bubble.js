import { Format, getCurrentEvent } from "alemonjs";

// src/response/bubble.ts
const RICH_PLATFORM = "qq-bot";
const MAX_INLINE_ACTIONS = 3;
const MAX_KEYBOARD_ACTIONS = 10;
const MAX_INLINE_LABEL = 12;
const MAX_KEYBOARD_LABEL = 4;
const MAX_COMMAND_LENGTH = 60;
const BUTTONS_PER_ROW = 5;
/** 键盘按钮短名：手机小号按钮上最多 4 个字，超出会被客户端挤断行。 */
const KEYBOARD_LABELS = {
	"/帮助": "帮助",
	"/帮助 聊天": "聊天",
	"/帮助 媒体": "图片",
	"/帮助 记忆": "记忆说明",
	"/帮助 人格": "人格说明",
	"/帮助 额度": "额度教程",
	"/帮助 数据": "数据",
	"/帮助 管理": "管理",
	"/帮助 全部": "完整说明",
	"/状态": "刷新",
	"/状态 详情": "详情",
	"/额度": "额度",
	"/额度 记录": "记录",
	"/额度 增加": "增加",
	"/额度 设置": "设置",
	"/个人密钥": "个人密钥",
	"/个人密钥 绑定": "绑定密钥",
	"/个人密钥 启用": "启用密钥",
	"/个人密钥 状态": "密钥状态",
	"/群密钥 绑定": "申请密钥",
	"/群密钥 状态": "群密钥",
	"/群密钥 启用": "启用",
	"/群密钥 停用": "停用",
	"/群密钥 移除": "移除",
	"/当前模型": "当前模型",
	"/模型列表": "模型列表",
	"/密钥配置": "密钥配置",
	"/移除密钥": "移除密钥",
	"/工具策略": "策略",
	"/工具策略 状态": "状态",
	"/工具策略 网页 开启": "网页开",
	"/工具策略 网页 关闭": "网页关",
	"/工具策略 文件 开启": "文件开",
	"/工具策略 文件 关闭": "文件关",
	"/主动搭话 状态": "状态",
	"/主动搭话 开启": "开启",
	"/主动搭话 关闭": "关闭",
	"/主动搭话 现在": "立即",
	"/语音引擎 状态": "状态",
	"/语音引擎 安装": "安装",
	"/隐私说明": "隐私",
	"/清除聊天记录": "清记录",
	"/清除群数据": "清除",
	"/清除群数据 确认": "确认",
	"/取消": "取消",
	"/聊天参考": "刷新",
	"/聊天参考 清除": "清除",
	"/记忆": "我的记忆",
	"/群记忆": "群记忆",
	"/记忆检索": "检索",
	"/过时记忆": "过时记忆",
	"/表情": "表情",
	"/模块状态": "模块状态",
	"/我是主人": "验证码",
	"/心情": "心情",
	"/人格": "人格",
	"/人格 帮助": "人格说明",
	"/人格 使用 默认": "恢复默认",
	"/新会话": "新会话",
	"/语音": "语音",
	"/提问": "提问"
};
const safe = (text) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/([\\`*_[\]~])/gu, "\\$1");
const resolvePlatform = (platform) => {
	if (platform) return platform;
	const current = getCurrentEvent();
	return typeof current?.Platform === "string" ? current.Platform : "";
};
/** 只有 QQ 官方机器人支持 Markdown 指令按钮和键盘按钮组，其余平台退回纯文本卡片。 */
const supportsBubbles = (platform) => resolvePlatform(platform).toLowerCase() === RICH_PLATFORM;
const clip = (value, limit) => {
	const chars = Array.from(value.trim() || "点我");
	return chars.length <= limit ? chars.join("") : chars.slice(0, limit).join("");
};
const inlineLabel = (value) => {
	const text = value.trim() || "点我";
	const chars = Array.from(text);
	return chars.length <= MAX_INLINE_LABEL ? text : `${chars.slice(0, 11).join("")}…`;
};
/** 键盘按钮只留 1-4 个字：优先用声明或内置短名，最后才截断。 */
const keyboardLabel = (action) => clip(action.short || KEYBOARD_LABELS[action.command] || action.label, MAX_KEYBOARD_LABEL);
/** 只按指令去重；同一条指令的不同用途（/个人密钥 状态 与 /个人密钥 绑定）都保留。 */
const normalizeActions = (actions) => {
	const kept = [];
	for (const action of actions) {
		const command = String(action?.command ?? "").trim();
		const title = String(action?.label ?? "").trim();
		if (!command || !title || command.length > MAX_COMMAND_LENGTH) continue;
		if (kept.some((item) => item.command === command)) continue;
		kept.push(action);
	}
	return kept.slice(0, MAX_KEYBOARD_ACTIONS);
};
const addInline = (md, actions) => {
	md.addNewline();
	for (const action of actions.slice(0, MAX_INLINE_ACTIONS)) md.addButton(inlineLabel(action.label), {
		data: action.command,
		autoEnter: false
	}).addText(" ");
};
const buildKeyboard = (actions) => {
	if (actions.length === 0) return null;
	const group = Format.createButtonGroup().smallButton();
	for (let index = 0; index < actions.length; index += BUTTONS_PER_ROW) {
		group.addRow();
		for (const action of actions.slice(index, index + BUTTONS_PER_ROW)) group.addButton(keyboardLabel(action), action.command, {
			type: "command",
			style: "blue",
			autoEnter: false,
			rawData: {}
		});
	}
	return group;
};
/** 行内按钮负责“看得见的那一步”，键盘按钮组兜住剩下的入口，两者都不自动发送。 */
const attach = (format, actions) => {
	const group = buildKeyboard(actions);
	return group ? format.addButtonGroup(group) : format;
};
const sectionBubble = (title, intro, sections, options = {}) => {
	const rich = supportsBubbles(options.platform);
	const md = Format.createMarkdown().addBold(safe(title));
	if (intro) md.addNewline().addText(safe(intro));
	for (const section of sections) {
		const actions = rich ? normalizeActions(section.actions ?? []) : [];
		const block = Format.createMarkdown().addBold(safe(section.title));
		if (section.text) block.addNewline().addText(safe(section.text));
		if (actions.length > 0) addInline(block, actions);
		md.addNewline().addNewline().addBlockquote(block);
	}
	const format = Format.create().addMarkdown(md);
	return rich ? attach(format, normalizeActions(sections.flatMap((section) => section.actions ?? []))) : format;
};
/** 系统提示与错误：单行保持纯文本，多行才成卡片，并按需挂上可点入口。 */
const noticeBubble = (text, options = {}) => commandBubble(text, options.title || "提示", {
	platform: options.platform,
	actions: options.actions
});
/** 多行说明与状态卡：加粗标题、逐行排版，并挂上应用自己声明的可点指令。 */
const commandBubble = (text, title, options = {}) => {
	const rich = supportsBubbles(options.platform);
	const actions = rich ? normalizeActions(options.actions ?? []) : [];
	if (!text.includes("\n") && actions.length === 0) return Format.create().addText(text);
	const md = Format.createMarkdown().addBold(safe(title)).addNewline().addNewline();
	for (const line of text.replace(/\n+$/u, "").split("\n")) {
		const match = line.match(/^([^：\n]{1,24})：(.*)$/u);
		if (match && !line.startsWith("/")) md.addBold(safe(`${match[1]}：`)).addText(safe(match[2]));
		else md.addText(safe(line));
		md.addNewline();
	}
	if (actions.length > 0) {
		const block = Format.createMarkdown().addText(safe("按钮只填入，不发送。"));
		addInline(block, actions);
		md.addNewline().addBlockquote(block);
	}
	const format = Format.create().addMarkdown(md);
	return rich ? attach(format, actions) : format;
};

export { KEYBOARD_LABELS, commandBubble, noticeBubble, sectionBubble, supportsBubbles };