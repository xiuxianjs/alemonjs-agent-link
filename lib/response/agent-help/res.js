import { quotaHelp } from "../../billing/help.js";
import { commandBubble, sectionBubble } from "../bubble.js";
import { Format, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/agent-help/res.ts
const topicKeys = [
	"聊天",
	"记忆",
	"人格",
	"群设置",
	"媒体",
	"数据",
	"管理"
];
const topicSections = (isPrivate, owner, topic) => {
	const item = (title, text, label, command) => ({
		title,
		text,
		actions: [{
			label,
			command
		}]
	});
	switch (topic) {
		case "聊天": return [
			item("直接聊", isPrivate ? "直接发消息即可，也可以用提问指令。" : "群里 @我，或说“肥鱼，帮我……”；也可以用提问指令。", "开始提问", "/提问"),
			item("停止当前回答", "取消自己正在生成或排队的请求。", "停止请求", "/取消"),
			item("换个话题", `清空短期对话，保留长期记忆和聊天记录。${isPrivate ? "" : "群内需要管理员或机器人主人操作。"}`, "新会话", "/新会话"),
			...!isPrivate ? [item("查看聊天参考", "查看机器人参考了哪些近期群消息；清除需管理员或机器人主人。", "聊天参考", "/聊天参考")] : []
		];
		case "记忆": return [
			item(isPrivate ? "我的记忆" : "本群记忆", "查看已记住的内容，在条目旁选择后续操作。", "查看记忆", isPrivate ? "/记忆" : "/群记忆"),
			item("找一条记忆", "输入关键词查找；查看来源可核对它从哪里得来。", "搜索记忆", "/记忆检索"),
			...isPrivate ? [item("告诉我你的偏好", "例如：/记住 回答时先说结论。修改记忆会开始新话题，聊天记录仍保留。", "填写偏好", "/记住")] : [item("旧记忆与整理", "查看历史版本；恢复、整理或删除需要管理员或机器人主人。修改后会开始新话题，聊天记录仍保留。", "过时记忆", "/过时记忆")]
		];
		case "人格": return [
			item("换一种性格", "查看人格列表。切换会开始新话题；修改需机器人主人或 Key 权益，群内还需管理员身份。", "人格列表", "/人格"),
			item("改称呼和习惯", "只改当前会话的姓名、语气、爱好等细节。进入后选择要修改的项目。", "人设细节", "/人设"),
			item("看看当前心情", "查看机器人的情绪状态。", "查看心情", "/心情"),
			item("更多人格设置", "查看调整方式、权限说明和可用入口。", "人格帮助", "/人格 帮助")
		];
		case "群设置": return isPrivate ? [item("请在目标群操作", "私聊没有群设置。在想调整的群里发送 /群设置。", "返回目录", "/帮助")] : [item("本群的互动方式", "群成员都能查看，管理员和机器人主人可以修改活跃程度、免打扰时段、唤醒词和禁语。", "打开群设置", "/群设置"), item("更多设置", "语音、人设、修改记录和恢复默认都在设置中。人设修改还需要本群 Key 权益；重置不清除人设与钥匙授权。", "设置说明", "/群设置 帮助")];
		case "媒体": return [
			item("图片与语音", "可以直接发图、发语音或说想画什么。想听语音回答时，进入后填写问题；语音不可用会回退文字。", "语音提问", "/语音"),
			item("发送表情", "查看可用素材，在喜欢的条目旁选择发送。", "挑选表情", "/表情"),
			...owner ? [item("管理表情收藏", "导入、同步和删除素材；也可以发图并说“做成表情包”。", "表情管理", "/表情 帮助")] : [],
			...isPrivate && owner ? [item("本地语音引擎", "先检查状态，再按提示安装或试听。", "检查语音引擎", "/语音引擎 状态")] : []
		];
		case "数据": return [
			item("数据怎么保存", "聊天记录和长期记忆分别保存、分别删除。", "隐私说明", "/隐私说明"),
			item("只换话题", `清空短期对话，保留记录与记忆。${isPrivate ? "" : "群内需管理员或机器人主人。"}`, "新会话", "/新会话"),
			...isPrivate || owner ? [item("删除聊天记录", "永久删除当前会话的聊天归档，先查看范围再确认；不会删除长期记忆。", "查看清除范围", "/清除聊天记录")] : [],
			item("删除记忆", isPrivate ? "打开自己的记忆，找到要忘记的条目。" : "打开群记忆，找到要忘记的条目；删除需管理员或机器人主人。", "查看记忆", isPrivate ? "/记忆" : "/群记忆"),
			...!isPrivate && owner ? [item("彻底清理本群", "清除群数据会永久删除相关内容，操作前需确认。", "查看清理范围", "/清除群数据")] : []
		];
		case "管理": return isPrivate && owner ? [
			{
				title: "服务与开关",
				text: "查看运行状态和模块。暂停全局 AI 可发送 /关闭 原因，恢复发送 /开启。",
				actions: [{
					label: "查看状态",
					command: "/状态"
				}, {
					label: "模块状态",
					command: "/模块状态"
				}]
			},
			item("权限与智能程度", "查看自己的权益及智能程度。终端仅限主人私聊主动任务，并需工作区就绪。", "我的权限", "/我的权限"),
			{
				title: "模型与额度",
				text: "查看当前模型、可用模型及端点额度，在对应条目旁操作。",
				actions: [
					{
						label: "当前模型",
						command: "/当前模型"
					},
					{
						label: "模型列表",
						command: "/模型列表"
					},
					{
						label: "额度轮转",
						command: "/额度轮转"
					}
				]
			},
			item("Token 用量", "查看今日消耗，再切换本月、本年或累计统计。", "查看用量", "/用量"),
			item("工具与主动搭话", "工具权限请在目标群发送 /工具策略；主动搭话入口可查看状态、开关和作息。OneBot 管群还需白名单及平台权限。", "主动搭话", "/主动搭话")
		] : [item("主人专用", "请机器人主人私聊查看管理说明。", "查看我的权限", "/我的权限")];
		default: return [];
	}
};
const sectionText = (section) => `${section.title}\n${section.text}\n${(section.actions || []).map((action) => `${action.label}：${action.command}`).join("\n")}`;
const helpText = (isPrivate, owner, topic = "") => {
	if (topic === "额度" || topic === "密钥") return quotaHelp(isPrivate);
	if (topic === "全部") return [...topicKeys.filter((key) => (key !== "管理" || isPrivate && owner) && (key !== "群设置" || !isPrivate)).map((key) => helpText(isPrivate, owner, key)), quotaHelp(isPrivate)].join("\n\n");
	if (topic) return topicSections(isPrivate, owner, topic).map(sectionText).join("\n\n") || "发送 /帮助 查看目录。";
	return helpSections(isPrivate, owner).map(sectionText).join("\n\n");
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
		text: "查看人格与心情。切换人格会开始新话题；具体修改权限和入口见人格说明。",
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
	const sections = topicSections(isPrivate, owner, topic);
	if (sections.length) return sectionBubble(`大肥鱼 · ${topic}`, "按需要选择下方入口，点击后发送指令。", sections, {
		platform,
		actions: [{
			label: "目录",
			command: "/帮助"
		}]
	});
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
	else if (!topicKeys.includes(topic) && ![
		"额度",
		"密钥",
		"全部"
	].includes(topic)) {
		next();
		return;
	}
	const pages = topic === "全部" ? [...topicKeys.filter((key) => (key !== "管理" || event.IsPrivate && event.IsMaster) && (key !== "群设置" || !event.IsPrivate)), "额度"] : [topic];
	for (const page of pages) await message.send({ format: helpFormat(Boolean(event.IsPrivate), Boolean(event.IsMaster), page, event.Platform) });
};

export { res_default as default, helpFormat, helpText };