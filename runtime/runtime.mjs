import { fork } from 'node:child_process';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { appendDiagnostic, captureLines } from './diagnostics.mjs';

export const launchRuntime = async ({ cwd, configPath, dataRoot, runtimeRoot, write, ownership, spawnWorker = fork, timeoutMs = 120000 }) => {
  const diagnostics = join(runtimeRoot, 'startup.log');
  const statusPath = join(runtimeRoot, 'startup-status.json');
  // A previous run's ready record must never satisfy the new run's readiness.
  await rm(statusPath, { force: true });
  const child = spawnWorker(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
    cwd,
    env: {
      ...process.env,
      CFG_PATH: configPath,
      AGENT_LINK_DATA_DIR: dataRoot,
      AGENT_LINK_STATUS_PATH: statusPath,
      LOG_FILE: 'false',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      LOG_PATH: join(runtimeRoot, 'logs')
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });
  captureLines(child.stdout, diagnostics, configPath);
  captureLines(child.stderr, diagnostics, configPath);
  let qqReady = false;
  let moduleReady = false;
  let chatReady = false;
  let completed = false;
  let stopping = false;
  let killTimer;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    killTimer.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const disconnect = () => stop();
  process.once('exit', disconnect);
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let qrDeadline;
  const timedOut = () => {
    write(`尚未完成连接，请检查网络或扫码状态。诊断日志：${diagnostics}`);
    stop();
    rejectReady(Object.assign(new Error('Runtime readiness timed out'), { code: 'ERUNTIME_TIMEOUT', logPath: diagnostics }));
  };
  let timeout = setTimeout(timedOut, timeoutMs);
  const ownershipWatch = setInterval(() => {
    try {
      ownership.assertOwned?.();
    } catch (error) {
      write('数据目录占用已变化，正在停止当前实例。请确认只运行一份机器人。');
      stop();
      if (!completed) rejectReady(error);
      else process.exitCode = 1;
    }
  }, 1000);
  ownershipWatch.unref();
  const finish = () => {
    if (!completed && qqReady && moduleReady && chatReady) {
      completed = true;
      clearTimeout(timeout);
      write(`机器人已在线，聊天运行时已准备。模型连接以实际回复为准。\n诊断及主人验证码日志：${diagnostics}`);
      resolveReady();
    }
  };
  child.on('message', message => {
    if (stopping) return;
    if (message?.type === 'agent-link.state') {
      moduleReady = message.module === 'app_ready';
      chatReady = message.chatReady || message.phase === 'ready';
      if (message.module === 'failed' || (message.phase === 'failed' && !message.chatReady)) {
        appendDiagnostic(diagnostics, '应用或严格沙箱启动失败，请运行 doctor 检查配置。', configPath);
        stop();
        rejectReady(Object.assign(new Error('Application startup failed'), { code: 'ERUNTIME', logPath: diagnostics }));
      }
      finish();
    }
    const payload = message?.type === 'cbp.event' ? message.data : null;
    const event = payload?.protocol === 'cbp' && payload?.type === 'event' ? payload.payload?.event : payload;
    if (event?.name === 'connection.ready') {
      qqReady = true;
      finish();
    }
    if (event?.name === 'login.qrcode' && typeof event.QRCode?.url === 'string') {
      qrDeadline ??= Date.now() + 600000;
      clearTimeout(timeout);
      timeout = setTimeout(timedOut, Math.max(1, qrDeadline - Date.now()));
      write('请使用手机 QQ 扫码授权。授权会更新该机器人的密钥，已有其他实例需同步更新。');
      void QRCode.toString(event.QRCode.url, { type: 'terminal', small: true })
        .then(qr => {
          if (!stopping) write(qr);
        })
        .catch(() => write('二维码显示失败，请填写已有 QQ 凭证后重试。'));
    }
    if (event?.name === 'login.success') write('QQ 授权已保存，正在连接。');
  });
  child.once('error', error => {
    appendDiagnostic(diagnostics, error.code || 'Runtime child error', configPath);
    stop();
    rejectReady(error);
  });
  child.once('close', async (code, signal) => {
    clearTimeout(timeout);
    clearInterval(ownershipWatch);
    clearTimeout(killTimer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.removeListener('exit', disconnect);
    await ownership.release().catch(() => undefined);
    if (!completed) rejectReady(Object.assign(new Error('Runtime stopped before readiness'), stopping ? { code: 'ABORT_ERR' } : {}));
    else if (code && !stopping) {
      write(`机器人已停止，请查看诊断日志：${diagnostics}`);
      process.exitCode = 1;
    }
  });
  try {
    await ready;
  } catch (error) {
    stop();
    // Keep the instance lock until the worker has actually exited.
    await new Promise(resolve => {
      if (child.exitCode !== null && child.exitCode !== undefined) resolve();
      else child.once('close', resolve);
    });
    throw error;
  }
};
