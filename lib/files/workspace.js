import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";

// src/files/workspace.ts
const maxFileBytes = 262144;
const maxTotalBytes = 10485760;
const maxEntries = 1e3;
const missing = (error) => error.code === "ENOENT";
const deny = () => {
	throw new Error("文件路径不允许：只能操作当前会话目录内的普通文件和目录。");
};
const stat = (path) => {
	try {
		const info = lstatSync(path);
		if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory() || info.isFile() && info.nlink !== 1) deny();
		return info;
	} catch (error) {
		if (missing(error)) return void 0;
		throw error;
	}
};
const parts = (path) => {
	if (typeof path !== "string" || path.length > 512 || /[\\:]/u.test(path) || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) deny();
	if (path === ".") return [];
	const result = path.split("/");
	if (result.length > 16 || result.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 200)) deny();
	return result;
};
const scope = (context) => {
	if (!context.capabilities.files || context.autonomous || !context.platform || !context.channelId || !(context.private ? context.userId : context.channelId)) throw new Error("当前会话没有文件权限或缺少可信身份。");
	return [
		context.private ? "users" : "groups",
		createHash("sha256").update(context.channelId).digest("hex"),
		createHash("sha256").update(JSON.stringify([
			context.platform,
			context.botId || "",
			context.private ? context.userId : context.channelId
		])).digest("hex")
	];
};
const workspaceOperation = (base, context, action, args) => {
	context.signal.throwIfAborted();
	const identity = scope(context);
	const requested = parts(args.path ?? ".");
	const destination = action === "move" ? parts(args.destination) : void 0;
	const configured = resolve(base);
	mkdirSync(configured, {
		recursive: true,
		mode: 448
	});
	let root = realpathSync(configured);
	for (const component of ["scoped-files", ...identity]) {
		root = join(root, component);
		const info = stat(root);
		if (!info) mkdirSync(root, { mode: 448 });
		else if (!info.isDirectory()) deny();
	}
	const locate = (segments) => {
		let path = root;
		for (let i = 0; i < segments.length; i++) {
			path = join(path, segments[i]);
			const info = stat(path);
			if (i < segments.length - 1 && !info?.isDirectory()) deny();
		}
		return path;
	};
	const path = locate(requested);
	const info = stat(path);
	const inventory = () => {
		let bytes = 0, entries = 0;
		const visit = (directory, depth) => {
			if (depth > 16) deny();
			for (const name of readdirSync(directory)) {
				if (++entries > maxEntries) throw new Error("目录条目超过上限，请先清理文件。");
				const child = join(directory, name), item = stat(child);
				if (!item) deny();
				if (item.isDirectory()) visit(child, depth + 1);
				else bytes += item.size;
			}
		};
		visit(root, 0);
		return {
			bytes,
			entries
		};
	};
	if (action === "list") {
		if (!info?.isDirectory()) throw new Error("目录不存在。");
		const names = readdirSync(path).sort();
		return {
			path: args.path ?? ".",
			entries: names.slice(0, 200).map((name) => {
				const item = stat(join(path, name));
				return {
					name,
					type: item?.isDirectory() ? "directory" : "file",
					bytes: item?.size
				};
			}),
			truncated: names.length > 200
		};
	}
	if (action === "read") {
		if (!info?.isFile() || info.size > maxFileBytes) throw new Error("只能读取不超过 256 KiB 的文本文件。");
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const actual = fstatSync(fd);
			if (!actual.isFile() || actual.nlink !== 1 || actual.size > maxFileBytes) deny();
			return {
				path: args.path,
				content: new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd))
			};
		} finally {
			closeSync(fd);
		}
	}
	if (!requested.length) deny();
	if (action === "delete") {
		if (!info) throw new Error("文件或目录不存在。");
		if (info.isDirectory()) rmdirSync(path);
		else unlinkSync(path);
		return {
			ok: true,
			path: args.path
		};
	}
	if (action === "move") {
		if (!info || !destination?.length) deny();
		const target = locate(destination);
		if (stat(target)) throw new Error("目标已存在，不能覆盖。");
		if (!info.isFile()) throw new Error("移动操作仅支持普通文件。");
		renameSync(path, target);
		return {
			ok: true,
			path: args.destination
		};
	}
	if (action !== "write" && action !== "mkdir") throw new Error("未知文件操作。");
	const usage = inventory();
	if (!info && usage.entries >= maxEntries) throw new Error("每个目录最多 1000 个条目。");
	if (action === "mkdir") {
		if (info && !info.isDirectory()) deny();
		if (!info) mkdirSync(path, { mode: 448 });
		return {
			ok: true,
			path: args.path
		};
	}
	if (typeof args.content !== "string") throw new Error("缺少文本内容。");
	const bytes = Buffer.byteLength(args.content);
	if (bytes > maxFileBytes || usage.bytes - (info?.size || 0) + bytes > maxTotalBytes) throw new Error("文件限 256 KiB，会话目录总量限 10 MiB。");
	if (info && (!info.isFile() || args.overwrite !== true)) throw new Error("文件已存在；明确替换内容时才可设置 overwrite。");
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (info ? constants.O_TRUNC : constants.O_EXCL), 384);
	try {
		writeFileSync(fd, args.content, "utf8");
	} finally {
		closeSync(fd);
	}
	return {
		ok: true,
		path: args.path,
		bytes
	};
};
const purgeWorkspaceHash = (base, hash) => {
	if (!/^[a-f0-9]{64}$/u.test(hash)) deny();
	if (!stat(resolve(base))) return;
	const root = join(realpathSync(resolve(base)), "scoped-files");
	if (!stat(root)?.isDirectory()) return;
	for (const kind of ["groups", "users"]) {
		const parent = join(root, kind);
		if (!stat(parent)?.isDirectory()) continue;
		const target = join(parent, hash);
		if (!stat(target)?.isDirectory()) continue;
		rmSync(target, { recursive: true });
	}
};

export { purgeWorkspaceHash, workspaceOperation };