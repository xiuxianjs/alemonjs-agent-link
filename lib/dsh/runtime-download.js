import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// src/dsh/runtime-download.ts
const downloadRuntime = async (url, sha256, signal, fetcher = fetch, maxBytes = 67108864) => {
	for (let attempt = 0; attempt < 3; attempt++) {
		signal.throwIfAborted();
		let retry = true;
		try {
			const response = await fetcher(url, { signal });
			if (!response.ok) {
				retry = response.status === 408 || response.status === 429 || response.status >= 500;
				await response.body?.cancel();
				throw new Error(`Managed Python bootstrap download failed (HTTP ${response.status})`);
			}
			if (!response.body) throw new Error("Managed Python bootstrap download failed (empty response)");
			const reader = response.body.getReader();
			const chunks = [];
			let size = 0;
			try {
				while (true) {
					signal.throwIfAborted();
					const part = await reader.read();
					if (part.done) break;
					size += part.value.byteLength;
					if (size > maxBytes) {
						retry = false;
						throw new Error("Managed Python bootstrap download failed (size limit)");
					}
					chunks.push(part.value);
				}
			} finally {
				await reader.cancel().catch(() => void 0);
			}
			const bytes = Buffer.concat(chunks);
			if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
				retry = false;
				throw new Error("Managed Python bootstrap checksum mismatch");
			}
			return bytes;
		} catch (error) {
			signal.throwIfAborted();
			if (!retry || attempt === 2) throw error;
			await setTimeout(250 * (attempt + 1), void 0, { signal });
		}
	}
	throw new Error("Managed Python bootstrap download failed");
};

export { downloadRuntime };