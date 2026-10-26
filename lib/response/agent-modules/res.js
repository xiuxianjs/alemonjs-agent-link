import { getDSHConfig } from "../../dsh/client.js";
import { getModuleRuntime } from "../../agent/modules.js";
import { Format, useEvent, useMessage } from "alemonjs";

// src/response/agent-modules/res.ts
var res_default = async () => {
	const [context] = useEvent({ selects: "private.message.create" });
	if (!context.match.selects || !context.current.IsMaster) return;
	const [message] = useMessage();
	let text;
	try {
		const runtime = await getModuleRuntime(getDSHConfig());
		await runtime.refresh();
		text = [
			"AgentLink 模块",
			...runtime.status().map((item) => `${item.id}：${item.state === "ready" ? `已加载 ${item.version}` : item.state === "disabled" ? "已停用" : "加载失败"}${item.error ? `（${item.error}）` : ""}`),
			"本地模块每次请求前检查更新；当前请求会使用开始时的版本。"
		].join("\n");
	} catch {
		text = "模块配置或目录不可用，请检查服务端配置和文件权限。";
	}
	await message.send({ format: Format.create().addText(text) });
};

export { res_default as default };