import { readPublicPage, readablePublicText } from "../proactive/public-web.js";
import { inspectLinks } from "../media/links.js";

// src/modules/web.ts
const webModule = () => ({
	id: "web",
	name: "网页与链接",
	version: "1.0.0",
	apiVersion: 1,
	setup(api) {
		api.tool({
			name: "inspect_links",
			readOnly: true,
			description: "识别用户提供文本中的 URL，区分普通网页、B站、图片、音频和视频链接；只分类，不代表读过内容。",
			parameters: {
				type: "object",
				properties: { text: {
					type: "string",
					minLength: 1,
					maxLength: 16e3
				} },
				required: ["text"],
				additionalProperties: false
			},
			available: (context) => !context.autonomous,
			execute: ({ text }) => Promise.resolve(inspectLinks(String(text)))
		});
		const reads = /* @__PURE__ */ new WeakMap();
		api.tool({
			name: "read_public_url",
			readOnly: true,
			description: "按用户要求读取公开 HTTPS 网页正文。不能读取本机、内网、登录态或视频画面；B站视频优先使用 bili 工具。不会发布评论。",
			parameters: {
				type: "object",
				properties: { url: {
					type: "string",
					minLength: 1,
					maxLength: 2e3
				} },
				required: ["url"],
				additionalProperties: false
			},
			available: (context) => !context.autonomous && context.capabilities.web,
			execute: async ({ url }, context) => {
				if (context.autonomous || !context.capabilities.web) throw new Error("当前会话未开放网页读取。");
				const count = reads.get(context) || 0;
				if (count >= 3) throw new Error("本轮网页读取已达 3 次上限。");
				reads.set(context, count + 1);
				try {
					const page = await readPublicPage(String(url), context.signal);
					return readablePublicText(page.text) ? {
						status: "read",
						...page
					} : {
						status: "unavailable",
						message: "正文不足或需要登录／验证，不能据此声称已读完网页。"
					};
				} catch {
					context.signal.throwIfAborted();
					return {
						status: "unavailable",
						message: "无法读取公开页面。可能是地址被限制、网络失败或页面不提供静态正文。"
					};
				}
			}
		});
	}
});

export { webModule };