import lockfile from 'proper-lockfile';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const readOwner = async path => {
  try {
    const raw = await readFile(path, 'utf8');
    const value = JSON.parse(raw);
    const pid = typeof value === 'number' ? value : value?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid owner');
    return { pid, token: value?.token };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    const failure = new Error('实例锁无法读取，请确认文件权限；不要删除正在运行的实例锁。');
    failure.code = 'ELOCKED';
    throw failure;
  }
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    return true;
  }
};
const locked = () => Object.assign(new Error('另一个进程正在使用该数据目录，请使用已有实例。'), { code: 'ELOCKED' });

// proper-lockfile uses atomic mkdir plus a heartbeat, and reclaims abandoned
// locks after a bounded stale interval. The marker also protects older releases
// which still use PID-only state.json.lock files.
export const acquireProcessLock = async path => {
  path = resolve(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const previous = await readOwner(path);
  if (previous && alive(previous.pid)) throw locked();
  let compromised;
  const options = {
    realpath: false,
    lockfilePath: `${path}.owner`,
    stale: 5000,
    update: 1000,
    retries: { retries: 10, factor: 1, minTimeout: 600, maxTimeout: 600 },
    onCompromised(error) {
      compromised = error;
    }
  };
  let unlock;
  try {
    unlock = await lockfile.lock(path, options);
  } catch (error) {
    if (error.code === 'ELOCKED') throw locked();
    throw error;
  }
  const token = randomUUID();
  let released = false;
  const removeMarker = () => {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
    } catch {
      /* Ownership changed or marker already removed. */
    }
  };
  try {
    const owner = await readOwner(path);
    if (owner && alive(owner.pid)) throw locked();
    const recovery = await readOwner(`${path}.recovery`);
    if (recovery && alive(recovery.pid)) throw locked();
    if (recovery) await unlink(`${path}.recovery`);
    await writeFile(path, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flush: true });
    process.once('exit', removeMarker);
    return {
      assertOwned() {
        try {
          if (!compromised && !released && existsSync(options.lockfilePath) && JSON.parse(readFileSync(path, 'utf8')).token === token) return;
        } catch {
          /* Missing or replaced ownership. */
        }
        throw Object.assign(new Error('实例锁已丢失，已停止使用该数据目录。'), { code: 'ELOCKLOST' });
      },
      async release() {
        if (released) return;
        released = true;
        process.removeListener('exit', removeMarker);
        removeMarker();
        try {
          await unlock();
        } catch (error) {
          if (error.code !== 'ERELEASED' && error.code !== 'ECOMPROMISED') throw error;
        }
      }
    };
  } catch (error) {
    await unlock();
    throw error;
  }
};
