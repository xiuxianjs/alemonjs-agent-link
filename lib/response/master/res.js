import { commandBubble } from "../bubble.js";
import { masterVerification } from "../../state/master-verification.js";
import { createUserHashKey, getConfig, isMaster, logger, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/master/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	const reply = (text, actions = [{
		label: "重新获取验证码",
		command: "/我是主人"
	}]) => message.send({ format: commandBubble(text, "主人验证", {
		platform: event.Platform,
		actions
	}) });
	const ownerActions = [{
		label: "我的权限",
		command: "/我的权限"
	}, {
		label: "管理说明",
		command: "/帮助 管理"
	}];
	if (event.IsMaster || isMaster(event.UserId, event.Platform)) {
		await reply("你已经是机器人主人，无需再次验证。", ownerActions);
		return;
	}
	const identity = JSON.stringify([event.Platform, event.UserId]);
	if (route.key === "我是主人" && route.rawArgs.length === 0) {
		const code = masterVerification.issue(identity);
		logger.info({
			platform: event.Platform,
			userId: event.UserId,
			code
		}, "AgentLink 主人验证码（5 分钟有效）");
		await reply("验证码已写入服务端日志，5 分钟有效。\n读取日志中的六位数字，点击「填写验证码」，在指令后填入数字并发送。\n重新获取会使旧码失效。", [{
			label: "填写验证码",
			command: "/我的主人 "
		}, {
			label: "重新获取",
			command: "/我是主人"
		}]);
		return;
	}
	const code = String(route.rawArgs[0] ?? "");
	if (route.key !== "我的主人" || route.rawArgs.length !== 1 || !/^\d{6}$/.test(code)) {
		await reply("请填写服务端日志中的六位数字，不要把“六位验证码”这几个字发过来。", [{
			label: "填写验证码",
			command: "/我的主人 "
		}, {
			label: "获取验证码",
			command: "/我是主人"
		}]);
		return;
	}
	if (!masterVerification.verify(identity, code)) {
		await reply("验证码无效（最多尝试5次）。可发送 /我是主人 重新申请。");
		return;
	}
	try {
		const config = getConfig();
		const value = config.value ?? {};
		const userKey = createUserHashKey(event);
		const masters = value.master_key;
		config.saveValue({
			...value,
			master_key: Array.isArray(masters) ? [.../* @__PURE__ */ new Set([...masters, userKey])] : {
				...masters,
				[userKey]: true
			}
		});
	} catch (error) {
		logger.error({ err: error }, "AgentLink 保存主人配置失败");
		await reply("验证码已验证，但主人配置保存失败。请检查服务端日志，再发送 /我是主人 重试。");
		return;
	}
	await reply("验证通过，你已成为机器人主人。可以查看自己的权限，或进入管理说明。", ownerActions);
};

export { res_default as default };