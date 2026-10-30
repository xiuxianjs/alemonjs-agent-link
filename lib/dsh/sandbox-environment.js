import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { access, stat } from "node:fs/promises";

// src/dsh/sandbox-environment.ts
const findExecutable = async (name, path = process.env.PATH ?? "") => {
	for (const directory of path.split(delimiter).filter(isAbsolute)) {
		const candidate = join(directory, name);
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {}
	}
};
const inspectBubblewrapInstaller = async (find = findExecutable, root = process.getuid?.() === 0) => {
	for (const name of ["apt-get", "dnf"]) {
		const executable = await find(name);
		if (!executable) continue;
		return {
			name,
			executable,
			sudo: root ? void 0 : await find("sudo"),
			root,
			manual: `sudo ${name} install -y bubblewrap`
		};
	}
};

export { findExecutable, inspectBubblewrapInstaller };