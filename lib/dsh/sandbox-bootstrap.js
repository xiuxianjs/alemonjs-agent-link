import { runQuiet } from "./python-bootstrap.js";

// src/dsh/sandbox-bootstrap.ts
const installBubblewrap = async (timeout, signal, runner = runQuiet) => {
	const deadline = Date.now() + timeout;
	for (const [command, args] of [
		["apt-get", [
			"install",
			"-y",
			"bubblewrap"
		]],
		["dnf", [
			"install",
			"-y",
			"bubblewrap"
		]],
		["apk", [
			"add",
			"--no-interactive",
			"bubblewrap"
		]]
	]) {
		signal?.throwIfAborted();
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		try {
			const root = process.getuid?.() === 0;
			await runner(root ? command : "sudo", root ? args : [
				"-n",
				command,
				...args
			], remaining, signal, void 0, { DEBIAN_FRONTEND: "noninteractive" });
			return;
		} catch {
			signal?.throwIfAborted();
		}
	}
	throw new Error("bubblewrap automatic installation unavailable; install bubblewrap with administrator privileges");
};

export { installBubblewrap };