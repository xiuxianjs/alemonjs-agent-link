import { DSHError } from "../dsh/errors.js";
import { getConversationId } from "../response/dsh/util.js";

// src/billing/commands.ts
const budgetHelp = [
	"额度查询与帮助向所有人开放；调整、记录及跨会话查询仅主人（单位：元；充值跨天保留，每日免费额度仅今天有效）",
	"/额度：查询；/额度 记录：最近5次调整。",
	"/额度 增加 2（或 充值）：增加会话充值额度，不扣个人免费额度。",
	"/额度 设置 5：群内设置本群今日感知预算；私聊设置该用户今日免费总额度，不重置用量。",
	"指定同平台目标：/额度 查询 群 群ID；/额度 增加 群 群ID 2；/额度 设置 私聊 用户ID 3。",
	"群付款顺序：共享 Key 池 → 发言人自己的 Key → 群充值（如有）→ 个人免费；感知判断最后使用群感知预算，每日默认1元。",
	"个人免费额度跨群及私聊共享；群与私聊充值分别使用。",
	"北京时间零点重置免费额度，充值余额结转；命令不涉及实际付款。"
].join("\n");
const parseBudgetCommand = (args, event) => {
	const scope = {
		platform: event.Platform || "",
		channelId: getConversationId(event)
	};
	if (!scope.platform || !scope.channelId) throw new DSHError("budget", "无法确定当前会话。");
	if (!args.length) return {
		action: "query",
		scope
	};
	if (args.length === 1 && args[0] === "帮助") return {
		action: "help",
		scope
	};
	if (args.length === 1 && args[0] === "查询") return {
		action: "query",
		scope
	};
	if (args.length && !event.IsMaster) throw new DSHError("budget", "只有机器人主人可以管理额度；发送 /额度 可查询当前会话。");
	const actions = {
		查询: "query",
		增加: "add",
		充值: "add",
		设置: "set",
		记录: "history"
	};
	const action = Object.hasOwn(actions, args[0]) ? actions[args[0]] : void 0;
	if (!action) throw new DSHError("budget", budgetHelp);
	const mutation = action === "add" || action === "set";
	const tail = args.slice(1);
	const amountText = mutation ? tail.pop() : void 0;
	if (tail.length) {
		if (tail.length !== 2 || !["群", "私聊"].includes(tail[0]) || !/^[^\s]{1,200}$/u.test(tail[1])) throw new DSHError("budget", budgetHelp);
		scope.channelId = tail[0] === "私聊" ? `private:${JSON.stringify([scope.platform, tail[1]])}` : tail[1];
		if (tail[0] === "群" && scope.channelId.startsWith("private:")) throw new DSHError("budget", "请使用 私聊 用户ID 指定私聊。");
	}
	if (!mutation) return {
		action,
		scope
	};
	if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/u.test(amountText || "")) throw new DSHError("budget", "请填写人民币金额，最多两位小数。例如：/额度 增加 2");
	const [whole, fraction = ""] = amountText.split(".");
	const amount = Number(whole) * 1e6 + Number(fraction.padEnd(2, "0")) * 1e4;
	if (amount > 1e10 || action === "add" && amount === 0) throw new DSHError("budget", "增加金额须大于 0，最多 10000 元；设置可为 0。");
	return {
		action,
		scope,
		amount
	};
};

export { budgetHelp, parseBudgetCommand };