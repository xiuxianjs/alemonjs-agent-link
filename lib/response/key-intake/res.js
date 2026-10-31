import { extractApiKeys, keyIntake } from "../../credentials/key-intake.js";
import { bindPersonalKey } from "../../credentials/personal.js";
import { getConversationId } from "../dsh/util.js";
import { commandBubble } from "../bubble.js";
import { changeKeyring } from "../../credentials/keyring.js";
import { useEvent, useMessage } from "alemonjs";

// src/response/key-intake/res.ts
var res_default = async () => {
	const [context, next] = useEvent({ selects: ["message.create", "private.message.create"] });
	if (!context.match.selects) {
		await Promise.resolve(next());
		return;
	}
	const event = context.current;
	const text = String(event.MessageText || "").trim();
	const keys = extractApiKeys(text);
	const confirmation = /^\/添加钥匙 (私聊|群聊) ([a-f0-9]{32})$/u.exec(text);
	if (!keys.length && !text.startsWith("/添加钥匙")) {
		await Promise.resolve(next());
		return;
	}
	const [message] = useMessage();
	const reply = async (text, actions = []) => {
		await message.send({ format: commandBubble(text, "添加钥匙", {
			platform: event.Platform,
			actions
		}) });
	};
	if (!event.IsPrivate || !event.Platform || !event.UserId || event.IsBot) {
		await reply("请私聊发送 Key，群里不接收密钥。");
		return;
	}
	const actor = JSON.stringify([
		event.Platform,
		event.BotId || "",
		event.UserId
	]);
	const scope = {
		platform: event.Platform,
		userId: event.UserId,
		channelId: getConversationId(event)
	};
	if (confirmation) {
		try {
			await keyIntake.confirm(actor, confirmation[2], (key) => confirmation[1] === "私聊" ? bindPersonalKey(scope, key) : changeKeyring(scope, "add", key));
			await reply(confirmation[1] === "私聊" ? "已添加本人钥匙，用于本人私聊及本人触发的群回复。" : "已存入群聊钥匙库，尚未分享。请到目标群通过 /我的钥匙 选择授权。", [{
				label: "查看钥匙",
				command: confirmation[1] === "私聊" ? "/我的钥匙 私聊" : "/我的钥匙 群聊"
			}]);
		} catch {
			await reply("添加未完成或操作已失效，请稍后重试；也可重新发送 Key 选择用途。");
		}
		return;
	}
	if (keys.length !== 1) {
		await reply(keys.length > 1 ? "识别到多把不同的 Key，请一次只发送一把。" : "这次添加已失效，请重新私聊发送 Key。");
		return;
	}
	try {
		const ticket = keyIntake.offer(actor, keys[0]);
		await reply("已识别 Key，请选择用途（5 分钟内有效）。\n私聊：用于本人，会替换当前个人钥匙。\n群聊：存入钥匙库，之后由你在目标群授权。", [{
			label: "添加到私聊",
			command: `/添加钥匙 私聊 ${ticket}`,
			autoEnter: true
		}, {
			label: "添加到群聊",
			command: `/添加钥匙 群聊 ${ticket}`,
			autoEnter: true
		}]);
	} catch {
		await reply("暂时无法准备添加，请稍后重试。");
	}
};

export { res_default as default };