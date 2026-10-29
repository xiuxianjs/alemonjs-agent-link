import { getConversationId } from "../dsh/util.js";
import { assertMessageDelivered } from "../../dsh/output.js";
import { noticeBubble } from "../bubble.js";
import { getAccount, removeAccount } from "../../credentials/account.js";
import { cancelLogin, loginAccount, loginStatus } from "../../credentials/account-login.js";
import { useEvent, useMedia, useMessage } from "alemonjs";

// src/response/personal-login/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: ["message.create", "private.message.create"] });
	const event = context.current;
	const match = /^[#/]个人(登录|退出)(?:\s+(.*))?$/u.exec(String(event.MessageText || "").trim());
	if (!context.match.selects || !match) {
		await Promise.resolve(next());
		return;
	}
	const [message] = useMessage();
	const [media] = useMedia();
	const reply = async (text, actions = []) => {
		await message.send({ format: noticeBubble(text, {
			platform: event.Platform,
			title: "个人登录",
			actions
		}) });
	};
	if (!event.IsPrivate || !event.Platform || !event.UserId || event.IsBot) {
		await reply("请在本人私聊使用个人登录。");
		return;
	}
	if (match[2] && !["状态", "取消"].includes(match[2]) || match[1] === "退出" && match[2]) {
		await reply("使用 /个人登录、/个人登录 状态、/个人登录 取消 或 /个人退出；请勿发送手机号或验证码。", [{
			label: "登录",
			command: "/个人登录"
		}]);
		return;
	}
	const scope = {
		platform: event.Platform,
		userId: event.UserId,
		channelId: getConversationId(event)
	};
	const loginReply = async (text) => {
		const actions = text.startsWith("请用微信扫描") ? [{
			label: "取消登录",
			command: "/个人登录 取消"
		}, {
			label: "状态",
			command: "/个人登录 状态"
		}] : text.startsWith("登录完成") ? [{
			label: "我的钥匙",
			command: "/我的钥匙"
		}, {
			label: "授权记录",
			command: "/授权记录"
		}] : text.includes("登录正在进行") ? [{
			label: "取消登录",
			command: "/个人登录 取消"
		}, {
			label: "状态",
			command: "/个人登录 状态"
		}] : text.includes("已登录") ? [{
			label: "退出",
			command: "/个人退出"
		}, {
			label: "我的钥匙",
			command: "/我的钥匙"
		}] : text.includes("已取消") ? [{
			label: "重新登录",
			command: "/个人登录"
		}] : [{
			label: "重新登录",
			command: "/个人登录"
		}, {
			label: "状态",
			command: "/个人登录 状态"
		}];
		await reply(text, actions);
	};
	try {
		if (match[1] === "退出") {
			await cancelLogin(scope);
			await removeAccount(scope);
			await reply("该扫码账户的私聊、群聊钥匙及群授权副本已移除。", [{
				label: "重新登录",
				command: "/个人登录"
			}]);
		} else if (match[2] === "取消") {
			await cancelLogin(scope);
			await reply("已请求取消登录。", [{
				label: "登录",
				command: "/个人登录"
			}, {
				label: "状态",
				command: "/个人登录 状态"
			}]);
		} else if (match[2] === "状态") {
			const pending = loginStatus(scope);
			const account = await getAccount(scope);
			await reply(pending || (account ? "已保存账户授权；实际有效性将在调用时确认。" : "尚未登录。"), pending ? [{
				label: "取消登录",
				command: "/个人登录 取消"
			}, {
				label: "状态",
				command: "/个人登录 状态"
			}] : account ? [{
				label: "退出",
				command: "/个人退出"
			}, {
				label: "我的钥匙",
				command: "/我的钥匙"
			}] : [{
				label: "登录",
				command: "/个人登录"
			}]);
		} else await loginAccount(scope, async (data) => {
			assertMessageDelivered([await media.send({
				type: "image",
				data: data.toString("base64"),
				name: "deepseek-login.png",
				replyId: event.MessageId
			})]);
		}, loginReply);
	} catch {
		await reply("账户操作未完成；退出时若远端撤销失败，本地授权仍已移除，请在平台检查。", [{
			label: "状态",
			command: "/个人登录 状态"
		}, {
			label: "重新登录",
			command: "/个人登录"
		}]);
	}
};

export { res_default as default };