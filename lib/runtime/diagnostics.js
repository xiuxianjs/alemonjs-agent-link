import { dirname } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { parseDocument } from "yaml";

// runtime/diagnostics.mjs
const redact = (text, config = {}) => {
	const secrets = [];
	const walk = (value) => {
		if (!value || typeof value !== "object") return;
		for (const [key, item] of Object.entries(value)) if (/api.?key|secret|password|authorization|token/i.test(key) && typeof item === "string" && item) {
			secrets.push(item);
			if (item.trim()) secrets.push(item.trim());
		} else if (item && typeof item === "object") walk(item);
	};
	walk(config);
	let output = String(text);
	for (const secret of secrets.sort((a, b) => b.length - a.length)) output = output.split(secret).join("[已隐藏]");
	return output.replace(/Bearer\s+[^\s'",}]+/gi, "Bearer [已隐藏]").replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[已隐藏]@").replace(/([?&](?:token|key|api_key|password|secret)=)[^\s&#]+/gi, "$1[已隐藏]");
};
const appendDiagnostic = (path, text, configPath = process.env.CFG_PATH) => {
	try {
		let config = {};
		if (configPath) try {
			config = parseDocument(readFileSync(configPath, "utf8")).toJS();
		} catch {
			return;
		}
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		try {
			if (statSync(path).size > 1048576) renameSync(path, `${path}.1`);
		} catch {}
		appendFileSync(path, redact(String(text), config).slice(-16e3) + "\n", { mode: 384 });
	} catch {}
};

export { appendDiagnostic, redact };