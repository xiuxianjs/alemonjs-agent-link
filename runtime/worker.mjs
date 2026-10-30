import packageInfo from '../package.json' with { type: 'json' };
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { parse } from 'yaml';
import { resolveOneBotConfig } from '../lib/onebot/config.js';

// The framework resolves application ownership only within cwd. A standalone
// installation may live outside the launch directory, so run from its package
// root while preserving the caller's configuration and data paths.
process.env.CFG_PATH = resolve(process.env.CFG_PATH || 'alemon.config.yaml');
for (const key of ['AGENT_LINK_DATA_DIR', 'AGENT_LINK_STATUS_PATH']) {
  if (process.env[key]) process.env[key] = resolve(process.env[key]);
}
process.chdir(fileURLToPath(new URL('../', import.meta.url)));

// AlemonJS exposes restart but no complete stop API. Track forks in this
// dedicated worker so shutdown can await both the app and QQ adapter on every OS.
let closing = false;
const children = new Set();
const nativeFork = childProcess.fork;
childProcess.fork = (...args) => {
  const child = nativeFork(...args);
  children.add(child);
  child.once('close', () => children.delete(child));
  if (closing) child.kill('SIGTERM');
  return child;
};
const { start, getModuleAdapterState, getPlatformAdapterState, shutdownLogger } = await import('alemonjs');

const shutdown = async () => {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  const deadline = Date.now() + 2500;
  while (children.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  for (const child of children) child.kill('SIGKILL');
  await shutdownLogger();
  process.exit(0);
};
for (const signal of ['SIGINT', 'SIGTERM', 'disconnect'])
  process.once(signal, () => {
    void shutdown();
  });
const launchConfig = parse(await readFile(process.env.CFG_PATH || 'alemon.config.yaml', 'utf8'));
const onebot = launchConfig?.[packageInfo.name]?.transport === 'onebot';
if (onebot) resolveOneBotConfig(launchConfig);
start({
  input: relative(process.cwd(), fileURLToPath(new URL('../lib/index.js', import.meta.url))),
  platform: onebot ? fileURLToPath(new URL('../lib/onebot/index.js', import.meta.url)) : fileURLToPath(import.meta.resolve('@alemonjs/qq-bot')),
  autoPort: true
});
let previous = '';
const timer = setInterval(async () => {
  try {
    let engine = {};
    try {
      engine = JSON.parse(await readFile(process.env.AGENT_LINK_STATUS_PATH, 'utf8'));
    } catch {
      /* Module still booting. */
    }
    const state = {
      type: 'agent-link.state',
      module: getModuleAdapterState().phase,
      platform: getPlatformAdapterState().phase,
      phase: engine.phase,
      chatReady: engine.chatReady === true
    };
    const serialized = JSON.stringify(state);
    if (serialized !== previous && process.connected) {
      previous = serialized;
      process.send(state);
    }
  } catch {
    /* Parent may be shutting down. */
  }
}, 250);
timer.unref();
