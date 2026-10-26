import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

// bin/process-lock.mjs
const readOwner = async (path) => {
	try {
		const raw = await readFile(path, "utf8");
		const value = JSON.parse(raw);
		const pid = typeof value === "number" ? value : value?.pid;
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid owner");
		return {
			pid,
			token: value?.token
		};
	} catch (error) {
		if (error.code === "ENOENT") return null;
		const failure = /* @__PURE__ */ new Error("实例锁无法读取，请确认文件权限；不要删除正在运行的实例锁。");
		failure.code = "ELOCKED";
		throw failure;
	}
};
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		return true;
	}
};
const locked = () => Object.assign(/* @__PURE__ */ new Error("另一个进程正在使用该数据目录，请使用已有实例。"), { code: "ELOCKED" });
const acquireProcessLock = async (path) => {
	path = resolve(path);
	await mkdir(dirname(path), {
		recursive: true,
		mode: 448
	});
	const previous = await readOwner(path);
	if (previous && alive(previous.pid)) throw locked();
	const options = {
		realpath: false,
		lockfilePath: `${path}.owner`,
		stale: 5e3,
		update: 1e3,
		retries: {
			retries: 10,
			factor: 1,
			minTimeout: 600,
			maxTimeout: 600
		}
	};
	let unlock;
	try {
		unlock = await lockfile.lock(path, options);
	} catch (error) {
		if (error.code === "ELOCKED") throw locked();
		throw error;
	}
	const token = randomUUID();
	let released = false;
	const removeMarker = () => {
		try {
			if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
		} catch {}
	};
	try {
		const owner = await readOwner(path);
		if (owner && alive(owner.pid)) throw locked();
		const recovery = await readOwner(`${path}.recovery`);
		if (recovery && alive(recovery.pid)) throw locked();
		if (recovery) await unlink(`${path}.recovery`);
		await writeFile(path, JSON.stringify({
			pid: process.pid,
			token
		}), {
			mode: 384,
			flush: true
		});
		process.once("exit", removeMarker);
		return { async release() {
			if (released) return;
			released = true;
			process.removeListener("exit", removeMarker);
			removeMarker();
			await unlock();
		} };
	} catch (error) {
		await unlock();
		throw error;
	}
};

export { acquireProcessLock };