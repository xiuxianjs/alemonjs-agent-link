import { masterVerification } from "../../state/master-verification.js";
import { Format, createUserHashKey, getConfig, isMaster, logger, useEvent, useMessage, useRoute } from "alemonjs";

// src/response/master/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: "private.message.create" });
	const [route] = useRoute();
	if (!context.match.selects || !route.matched) return;
	const event = context.current;
	const [message] = useMessage();
	const reply = (text) => message.send({ format: Format.create().addText(text) });
	if (event.IsMaster || isMaster(event.UserId, event.Platform)) {
		await reply("你已经是机器人主人。");
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
		await reply("请输入验证码：验证码已打印到机器人服务端日志，5 分钟内有效。请回复 /我的主人 {验证码} 或 /我是主人 {验证码}（将 {验证码} 替换为实际数字）。单独发送 /我是主人 会重新申请，使旧验证码失效。");
		return;
	}
	const code = String(route.rawArgs[0] ?? "");
	if (route.rawArgs.length !== 1 || !/^\d{6}$/.test(code)) {
		await reply("请回复 /我的主人 {验证码} 或 /我是主人 {验证码}，验证码为 6 位数字。");
		return;
	}
	if (!masterVerification.verify(identity, code)) {
		await reply("验证码错误、已过期或未申请。最多尝试 5 次，请检查验证码或发送 /我是主人 重新申请。");
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
	await reply("验证通过，已加入机器人主人配置。");
};

export { res_default as default };