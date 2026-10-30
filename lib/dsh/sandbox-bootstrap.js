import { runQuiet } from "./python-bootstrap.js";
import { findExecutable, inspectBubblewrapInstaller } from "./sandbox-environment.js";

// src/dsh/sandbox-bootstrap.ts
const installBubblewrap = async (timeout, signal, runner = runQuiet, inspect = inspectBubblewrapInstaller) => {
	const deadline = Date.now() + timeout;
	signal?.throwIfAborted();
	const plan = await inspect();
	if (!plan) throw new Error("Bubblewrap setup: 未找到受支持的 apt-get 或 dnf，请由管理员安装 bubblewrap。");
	if (!plan.root && !plan.sudo) throw new Error(`Bubblewrap setup: 当前账号没有 root 权限且未安装 sudo，请联系管理员执行：${plan.manual}。`);
	const run = async (args) => {
		signal?.throwIfAborted();
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Bubblewrap setup: 安装超时，请检查软件源和网络后重试。");
		await runner(plan.root ? plan.executable : plan.sudo, plan.root ? args : [
			"-n",
			plan.executable,
			...args
		], remaining, signal, void 0, { DEBIAN_FRONTEND: "noninteractive" });
	};
	try {
		await run([
			"install",
			"-y",
			"bubblewrap"
		]);
	} catch {
		signal?.throwIfAborted();
		if (plan.name === "apt-get") try {
			await run(["update"]);
			await run([
				"install",
				"-y",
				"bubblewrap"
			]);
			return;
		} catch {
			signal?.throwIfAborted();
		}
		throw new Error(`Bubblewrap setup: 自动安装失败，请检查网络和软件源；无免密 sudo 权限时由管理员执行：${plan.manual}。`);
	}
};

export { findExecutable, inspectBubblewrapInstaller, installBubblewrap };