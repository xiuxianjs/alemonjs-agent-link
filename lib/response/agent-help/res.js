import { quotaHelp } from "../../billing/help.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-help/res.ts
const topics = {
	聊天: [
		"聊天",
		"群里 @我 或说“肥鱼，帮我……”；私聊直接说，也可 /提问 你的问题。",
		"/取消：停止自己的生成或排队请求。",
		"/新会话：换话题，保留记忆与记录；群内需管理员或主人。",
		"/聊天参考：本群近期参考；/聊天参考 清除 需管理员或主人。"
	],
	记忆: [
		"记忆",
		"/记忆（私聊）或 /群记忆 查看；/记忆检索 关键词、/记忆来源 编号 搜索与核对。",
		"/记住 内容、/忘记 编号、/忘记全部：管理私聊偏好。",
		"/过时记忆 看旧版本；/恢复记忆 编号、/整理记忆、/忘记群记忆：群内需管理员或主人。",
		"改记忆会开始新话题；聊天记录须另外删除。"
	],
	人格: [
		"人格与心情",
		"/人格 查看；/人格 使用 编号 切换（群内需管理员或主人，会换话题）；/人格 使用 默认 恢复。",
		"/心情：查看当前心情。",
		"主人可用 /人格 程度 活跃|个性|工作|专业 切换交流方式；私聊可 /人格 全局程度 设默认。",
		"/人设 查看本会话专属细节；/人设 编辑 字段 内容；/人设 恢复默认。本人需绑定 Key，群内需群 Key 与管理员权限。",
		"主人私聊：/人格 追加、查看追加、清空追加 编号。",
		"主人私聊：/人格 查看 编号、保存 编号 名称|提示词、删除 编号。"
	],
	群设置: [
		"群设置（群里谁都能看，管理员能改）",
		"/群设置：看当前设置，卡片上带按钮。",
		"/群设置 帮助：列出全部指令和说明。",
		"常用：/群设置 安静｜正常｜活跃、/群设置 静默 1-8、/群设置 唤醒词 加 小鱼、/群设置 禁语 加 某词。",
		"语音：/群设置 语音 关闭 让本群一律文字；/群设置 语音 开启 恢复。",
		"人设：/群设置 人设 群里可以叫我阿鱼（重发覆盖）；/群设置 人设 查看｜清空。",
		"改错了发 /群设置 重置（不清除人设与钥匙授权）；谁在什么时候改的看 /群设置 记录。"
	],
	媒体: [
		"图片、语音与表情",
		"发图、发语音、说想画什么都可以，以实际能力为准。",
		"/语音 问题：语音回答，不可用时回退文字。",
		"/表情 查看素材，/表情 标签 发送。",
		"主人：/表情 导入|同步|删除 管理收藏；发图说“做成表情包”配字；可开仅回环的本地表情面板（需 token）。",
		"主人私聊 /语音引擎 状态，需要时 /语音引擎 安装，试听 /语音引擎 试听 你好。"
	],
	数据: [
		"记录与隐私",
		"/隐私说明：数据用途与删除方式。",
		"/新会话：清空短期对话，保留记录与记忆。",
		"/清除聊天记录：永久删除本会话归档，需确认；本人私聊或群主人可用。",
		"/忘记 编号、/忘记群记忆 编号或全部：分别删私聊或群记忆；/清除群数据：主人在目标群彻底清理，需确认。"
	],
	管理: [
		"主人管理",
		"/我的权限 查看身份与权益；/智能程度 轻快|标准|深度|专研|默认 调节当前会话。",
		"主人私聊可明确要求执行终端任务，需工作区已就绪；群聊和主动任务不开放终端。",
		"/关闭 原因、/开启：暂停或恢复 AI 请求。",
		"/状态、/模块状态、/额度 帮助：服务、功能与额度。",
		"/模型列表、/当前模型、/额度轮转：模型、Key 状态与补货；/额度轮转 2 翻页。",
		"/密钥配置、/移除密钥：公共凭证指引，请不要在聊天中发送密钥。",
		"/工具策略 状态 看本群权限；/工具策略 网页 开启（聊天、文件同理，关闭即停用），设置后会换话题。",
		"/主动搭话 开启|关闭 订阅；状态 查看；现在 立即尝试；暂停 分钟、恢复。",
		"OneBot 群管理需白名单与平台权限，请明确指定操作。",
		"首次验证：私聊 /我是主人，到服务端日志取验证码，再发 /我的主人 验证码（5 分钟有效，最多 5 次）。"
	]
};
const helpText = (isPrivate, owner, topic = "") => {
	if (topic === "额度" || topic === "密钥") return quotaHelp(isPrivate);
	if (topic === "管理" && !(isPrivate && owner)) return "管理说明请主人私聊发送 /帮助 管理。";
	if (topic === "群设置" && isPrivate) return "群设置只在群里使用；私聊没有本群设置。";
	if (topic && topic !== "全部") return topics[topic]?.join("\n") || "发送 /帮助 聊天、/帮助 记忆、/帮助 人格、/帮助 群设置、/帮助 媒体、/帮助 数据 或 /帮助 额度。";
	if (topic === "全部") return Object.entries(topics).filter(([key]) => key !== "管理" || isPrivate && owner).map(([, lines]) => lines.join("\n")).join("\n\n") + `\n\n${quotaHelp(isPrivate)}`;
	return helpSections(isPrivate, owner).map((section) => `${section.title}\n${section.text}\n${(section.actions || []).map((action) => action.command).join(" · ")}`).join("\n\n");
};
const helpSections = (isPrivate, owner) => [
	{
		title: "聊天与创作",
		text: `${isPrivate ? "私聊直接发消息（需已开放私聊）" : "群里 @我 或说“肥鱼，帮我……”"}；问答、整理文字、发图、语音、画图都可以。\n试试 /提问 帮我把这段话改得自然一点`,
		actions: [{
			label: "聊天用法",
			command: "/帮助 聊天"
		}, {
			label: "图片与语音",
			command: "/帮助 媒体"
		}]
	},
	{
		title: "换话题，也能记住你",
		text: "/新会话 换话题、/取消 停止请求；新话题保留记忆与记录。\n" + (isPrivate ? "偏好用 /记住 回答时先说结论，/记忆 查看。" : "/群记忆 查看本群记忆，/记忆检索 关键词 查找；群内改记忆需管理员或主人。"),
		actions: [{
			label: "记忆用法",
			command: "/帮助 记忆"
		}, {
			label: "查看记忆",
			command: isPrivate ? "/记忆" : "/群记忆"
		}]
	},
	{
		title: "性格与表达",
		text: "/人格 选人格、/心情 看心情；换人格会开新话题。\n主人可用 /人格 程度 工作 调整交流方式。",
		actions: [{
			label: "人格列表",
			command: "/人格"
		}, {
			label: "切换教程",
			command: "/帮助 人格"
		}]
	},
	{
		title: "额度与隐私",
		text: "/额度 看剩余与恢复时间；不足时看密钥教程或联系主人。\n记录与记忆分别保存、分别删除。",
		actions: [{
			label: "额度教程",
			command: "/帮助 额度"
		}, {
			label: "数据与删除",
			command: "/帮助 数据"
		}]
	},
	...isPrivate && owner ? [{
		title: "主人设置",
		text: "服务开关、模型、群权限、主动搭话；操作与示例见管理说明。",
		actions: [{
			label: "管理说明",
			command: "/帮助 管理"
		}]
	}] : []
];
const topicActions = (topic, isPrivate) => {
	switch (topic) {
		case "聊天": return [{
			label: "提问",
			command: "/提问"
		}, {
			label: "新会话",
			command: "/新会话"
		}];
		case "记忆": return [{
			label: "查看",
			command: isPrivate ? "/记忆" : "/群记忆"
		}, {
			label: "检索",
			command: "/记忆检索"
		}];
		case "人格": return [{
			label: "列表",
			command: "/人格"
		}, {
			label: "心情",
			command: "/心情"
		}];
		case "群设置": return isPrivate ? [] : [{
			label: "设置",
			command: "/群设置"
		}];
		case "媒体": return [{
			label: "语音",
			command: "/语音"
		}, {
			label: "表情",
			command: "/表情"
		}];
		case "额度": return isPrivate ? [{
			label: "钥匙",
			command: "/我的钥匙"
		}, {
			label: "登录",
			command: "/个人登录"
		}] : [{
			label: "钥匙",
			command: "/我的钥匙"
		}];
		case "数据": return [{
			label: "隐私",
			command: "/隐私说明"
		}];
		case "管理": return [{
			label: "状态",
			command: "/状态"
		}];
		default: return [];
	}
};
const helpFormat = (isPrivate, owner, topic = "", platform = "qq-bot") => {
	if (platform !== "qq-bot") return Format.create().addText(helpText(isPrivate, owner, topic));
	if (!topic) {
		const rows = [
			{
				key: "聊天",
				text: isPrivate ? "私聊直接发消息；/提问、/取消、/新会话" : "群里 @我 或说“肥鱼，帮我……”；/提问、/取消、/新会话"
			},
			{
				key: "记忆",
				text: isPrivate ? "查看、检索、记住、删除个人记忆" : "群记忆、检索、来源核对；修改需管理员或主人"
			},
			{
				key: "人格",
				text: "切换人格、查看心情、调整表达程度"
			},
			...!isPrivate ? [{
				key: "群设置",
				text: "管理员调整强度、免打扰、唤醒词与禁语"
			}] : [],
			{
				key: "媒体",
				text: "图片、语音、表情、画图"
			},
			{
				key: "额度",
				text: "剩余额度、充值、个人/群密钥"
			},
			{
				key: "数据",
				text: "隐私说明、清除聊天记录、清除群数据"
			},
			...isPrivate && owner ? [{
				key: "管理",
				text: "管理说明：服务开关、模型、工具权限、主动搭话"
			}] : []
		];
		return sectionBubble("大肥鱼 · 帮助指南(内测版)", "还在学习如何提升自己哦。", rows.map((row) => ({
			title: row.key,
			text: row.text,
			actions: [{
				label: "查看",
				command: `/帮助 ${row.key}`
			}]
		})), {
			platform,
			layout: "inline"
		});
	}
	const text = helpText(isPrivate, owner, topic);
	const lines = text.split("\n");
	const body = lines.length > 1 && lines[0].length <= 12 && !lines[0].startsWith("/") && !lines[0].includes("：") ? lines.slice(1).join("\n") : text;
	const content = [/编号|关键词|内容|模型ID|分钟/.test(body) ? "“编号”等字样换成自己的输入。" : "", body].filter(Boolean).join("\n\n");
	return commandBubble(content, `大肥鱼 · ${topic === "全部" ? "完整说明" : topic}`, {
		platform,
		layout: "inline",
		actions: [...topicActions(topic, isPrivate), {
			label: "目录",
			command: "/帮助"
		}]
	});
};
var res_default = async () => {
	const [context, next] = useEvent({ selects: ["message.create", "private.message.create"] });
	const [route] = useRoute();
	if (!context.match.selects) {
		next();
		return;
	}
	const event = context.current;
	const [message] = useMessage();
	const topic = route.rawArgs.join(" ").trim();
	if (!topic) next();
	else if (!Object.hasOwn(topics, topic) && ![
		"额度",
		"密钥",
		"全部"
	].includes(topic)) {
		next();
		return;
	}
	const pages = topic === "全部" ? [...Object.keys(topics).filter((key) => (key !== "管理" || event.IsPrivate && event.IsMaster) && (key !== "群设置" || !event.IsPrivate)), "额度"] : [topic];
	for (const page of pages) await message.send({ format: helpFormat(Boolean(event.IsPrivate), Boolean(event.IsMaster), page, event.Platform) });
};

export { res_default as default, helpFormat, helpText };