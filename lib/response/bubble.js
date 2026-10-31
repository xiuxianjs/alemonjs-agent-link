import { Format, getCurrentEvent } from "alemonjs";

// src/response/bubble.ts
const RICH_PLATFORM = "qq-bot";
const MAX_ACTIONS = 10;
const MAX_INLINE_LABEL = 12;
const MAX_COMMAND_LENGTH = 200;
const ACTIONS_PER_ROW = 3;
/** 兼容已有短名引用；当前渲染不再生成键盘按钮。 */
const KEYBOARD_LABELS = {
	"/帮助": "帮助",
	"/帮助 聊天": "聊天",
	"/帮助 媒体": "媒体",
	"/帮助 记忆": "记忆",
	"/帮助 人格": "人格",
	"/帮助 额度": "额度",
	"/帮助 数据": "数据",
	"/帮助 管理": "管理",
	"/帮助 全部": "完整说明",
	"/状态": "刷新",
	"/状态 详情": "详情",
	"/额度": "额度",
	"/额度 今日不再提醒": "今日免扰",
	"/额度 记录": "记录",
	"/额度 增加": "增加",
	"/额度 设置": "设置",
	"/我的钥匙": "我的钥匙",
	"/我的钥匙 私聊": "私聊钥匙",
	"/我的钥匙 私聊 添加": "添加钥匙",
	"/我的钥匙 私聊 启用": "启用钥匙",
	"/授权记录": "授权记录",
	"/当前模型": "当前模型",
	"/额度轮转": "额度轮转",
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
const inlineLabel = (value) => {
	const text = value.trim() || "点我";
	const chars = Array.from(text);
	return chars.length <= MAX_INLINE_LABEL ? text : `${chars.slice(0, 11).join("")}…`;
};
/** 只按指令去重；同一条指令的不同用途（/我的钥匙 私聊 与 /我的钥匙 私聊 添加）都保留。 */
const normalizeActions = (actions) => {
	const kept = [];
	for (const action of actions) {
		const target = String(action?.url ?? action?.command ?? "").trim();
		const title = String(action?.label ?? "").trim();
		if (!target || !title || target.length > (action.url ? 2048 : MAX_COMMAND_LENGTH)) continue;
		if (action.url) try {
			if (new URL(action.url).protocol !== "https:") continue;
		} catch {
			continue;
		}
		if (kept.some((item) => String(item.url ?? item.command ?? "").trim() === target)) continue;
		kept.push(action);
	}
	return kept.slice(0, MAX_ACTIONS);
};
/** Actions stay beside their content; no persistent bar or keyboard payload. */
const addActions = (md, actions, rich) => {
	for (const [index, action] of normalizeActions(actions).entries()) {
		if (index % ACTIONS_PER_ROW === 0 || !rich) md.addNewline();
		else md.addText("  ");
		if (action.url) md.addLink(inlineLabel(action.label), new URL(action.url).href.replace(/[()]/gu, (char) => char === "(" ? "%28" : "%29"));
		else if (rich) md.addButton(`‹${inlineLabel(action.label)}›`, {
			data: action.command,
			autoEnter: action.autoEnter === true
		});
		else md.addText(safe(`${action.label}：${action.command}`));
	}
};
const sectionBubble = (title, intro, sections, options = {}) => {
	const rich = supportsBubbles(options.platform);
	let footer = options.actions ?? [];
	if (options.page) {
		const size = Math.max(1, Math.floor(options.page.size) || 5);
		const pages = Math.max(1, Math.ceil(sections.length / size));
		const page = Math.min(pages, Math.max(1, Math.floor(options.page.current) || 1));
		sections = sections.slice((page - 1) * size, page * size);
		intro = `${intro}${intro ? "\n" : ""}第 ${page}/${pages} 页`;
		footer = [
			...page > 1 ? [{
				label: "上一页",
				command: `${options.page.command} ${page - 1}`
			}] : [],
			...page < pages ? [{
				label: "下一页",
				command: `${options.page.command} ${page + 1}`
			}] : [],
			...footer
		];
	}
	const md = Format.createMarkdown().addBold(safe(title));
	if (intro) md.addNewline().addText(safe(intro));
	if (options.layout !== "none" && options.header?.length) addActions(md, options.header, rich);
	for (const section of sections) {
		const block = Format.createMarkdown().addBold(safe(section.title));
		if (section.text) block.addNewline().addText(safe(section.text));
		if (options.layout !== "none") addActions(block, section.actions ?? [], rich);
		md.addNewline().addNewline().addBlockquote(block);
	}
	if (options.layout !== "none" && footer.length) {
		md.addNewline();
		addActions(md, footer, rich);
	}
	return Format.create().addMarkdown(md);
};
const noticeBubble = (text, options = {}) => commandBubble(text, options.title || "提示", options);
/** Long details preserve every character; navigation appears only after the final part. */
const detailBubbles = (text, title, options = {}, limit = 900) => {
	const size = Number.isFinite(limit) ? Math.max(1, Math.min(900, Math.floor(limit))) : 900;
	const chars = Array.from(text);
	const parts = [];
	for (let index = 0; index < chars.length; index += size) parts.push(chars.slice(index, index + size).join(""));
	if (!parts.length) parts.push("");
	return parts.map((part, index) => commandBubble(part, parts.length > 1 ? `${title} ${index + 1}/${parts.length}` : title, {
		...options,
		header: index === 0 ? options.header : [],
		actions: index === parts.length - 1 ? options.actions : []
	}));
};
const commandBubble = (text, title, options = {}) => {
	const rich = supportsBubbles(options.platform);
	const actions = options.layout === "none" ? [] : normalizeActions(options.actions ?? []);
	const header = options.layout === "none" ? [] : normalizeActions(options.header ?? []);
	if (!text.includes("\n") && actions.length === 0 && header.length === 0) return Format.create().addText(text);
	const md = Format.createMarkdown().addBold(safe(title));
	if (header.length) addActions(md, header, rich);
	md.addNewline().addNewline();
	for (const line of text.replace(/\n+$/u, "").split("\n")) {
		const match = line.match(/^([^：\n]{1,24})：(.*)$/u);
		if (match && !line.startsWith("/") && !line.startsWith("|")) md.addBold(safe(`${match[1]}：`)).addText(safe(match[2]));
		else md.addText(safe(line));
		md.addNewline();
	}
	if (actions.length) addActions(md, actions, rich);
	return Format.create().addMarkdown(md);
};

export { KEYBOARD_LABELS, commandBubble, detailBubbles, noticeBubble, sectionBubble, supportsBubbles };