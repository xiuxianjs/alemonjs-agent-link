import { readBounded } from "../media/http.js";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/dsh/managed-python.ts
const hashes = {
	"aarch64-apple-darwin": "60fbd5c8a1ed681845eea28d9d622fcde03c51e91a43465b64a1e17db1ed3472",
	"x86_64-apple-darwin": "63ba17fdda55ad1a230d4b37fc6017ffa10c23688c83818bd3bfdf914c652a02",
	"aarch64-unknown-linux-gnu": "229e194255c7958d86d56e8790d969a6f74736592133f0dfd0076f754c642c1d",
	"x86_64-unknown-linux-gnu": "f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645"
};
const installManagedPython = async (root, run, signal, timeout = 12e4) => {
	const target = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : ""}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;
	if (!["darwin", "linux"].includes(process.platform) || !hashes[target]) throw new Error("Managed Python platform unsupported");
	const tools = join(root, "tools");
	const uv = join(tools, "uv-0.13.6");
	await mkdir(tools, { recursive: true });
	try {
		await access(uv);
		await run(uv, ["--version"], Math.min(timeout, 5e3));
	} catch {
		signal?.throwIfAborted();
		await rm(uv, { force: true });
		const temporary = await mkdtemp(join(tools, ".uv-"));
		try {
			const response = await fetch(`https://github.com/astral-sh/uv/releases/download/0.13.6/uv-${target}.tar.gz`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
			if (!response.ok) throw new Error("Managed Python bootstrap download failed");
			const bytes = await readBounded(response, 67108864);
			if (createHash("sha256").update(bytes).digest("hex") !== hashes[target]) throw new Error("Managed Python bootstrap checksum mismatch");
			const archive = join(temporary, "uv.tar.gz");
			await writeFile(archive, bytes);
			await run("/usr/bin/tar", [
				"-xzf",
				archive,
				"-C",
				temporary
			], timeout);
			await rename(join(temporary, `uv-${target}`, "uv"), uv);
		} finally {
			await rm(temporary, {
				recursive: true,
				force: true
			});
		}
	}
	await run(uv, [
		"venv",
		"--python",
		"3.12",
		"--managed-python",
		"--seed",
		join(root, "venv")
	], timeout);
};

export { installManagedPython };