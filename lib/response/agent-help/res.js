import { Format, useEvent, useMessage } from "alemonjs";

//#region src/response/agent-help/res.ts
const groupHelp = [
	"# AgentLink",
	"想聊什么，直接说。",
	"",
	"## 开始聊天",
	"- `@机器人 你的问题`",
	"- `/chat 你的问题`",
	"- `/cancel`：取消正在生成的回复；若未在生成，则取消你最后一条排队请求。",
	"",
	"## 本群会话",
	"- 同一群共享一段对话；不同群彼此隔离。",
	"- `/new`：开始新话题，同时清除本群的短时聊天参考（管理员或主人）。",
	"- `/agentcontext`：查看下次会参考的近期群聊摘要。",
	"- `/agentcontext clear`：只清除近期摘要，不清除正式会话（管理员或主人）。",
	"",
	"## 数据与服务",
	"- `/agentprivacy`：查看数据说明。",
	"- `/agentstatus`：查看服务是否可用。",
	"- 默认可联网查询；文件和终端是否可用由主人在本群设置。",
	"",
	"主人可私聊机器人发送 `/agenthelp` 查看管理命令。"
].join("\n");
const ownerPrivateHelp = [
	"# AgentLink · 管理",
	"",
	"## 服务与模型",
	"- `/agentstatus`：查看完整运行状态。",
	"- `/agentmodels`：查看可用模型。",
	"- `/agentmodel [模型ID]`：查看或切换全局模型。",
	"",
	"## 凭证",
	"- `/agentbind <API_KEY> [BASE_URL]`：绑定全群共用凭证。",
	"- `/agentunbind`：移除已绑定凭证。",
	"- 绑定成功后，请立即删除包含 API Key 的私聊消息。",
	"",
	"## 在目标群内使用",
	"- `/agentpolicy status`：查看群策略。",
	"- `/agentpolicy chat|web|files|terminal on|off`：调整本群能力；调整后会开启新会话。",
	"- `/agentpurge`：查看彻底删除本群数据的确认提示。"
].join("\n");
var res_default = async () => {
	const [eventContext] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!eventContext.match.selects) return;
	const event = eventContext.current;
	const [message] = useMessage();
	await message.send({ format: Format.create().addMarkdownOriginal(event.IsPrivate && event.IsMaster ? ownerPrivateHelp : groupHelp) });
};

//#endregion
export { res_default as default };