import { agentPlatformIssue } from '../lib/dsh/platform-preflight.js';
import packageInfo from '../package.json' with { type: 'json' };
import { access, mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { launchPaths } from './paths.mjs';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { resolveOneBotConfig } from '../lib/onebot/config.js';
import { launchRuntime } from './runtime.mjs';
import { LineCounter, parseDocument } from 'yaml';

export const minimalConfig = `# 填好模型 API Key 后，再次运行同一条启动命令。
# QQ 凭证可留空，启动后按提示扫码；已有凭证可直接填写。
# 这份文件包含密钥，请不要发给别人。
qq-bot:
  app_id: '' # QQ 机器人 AppID
  secret: '' # QQ 机器人密钥

${packageInfo.name}:
  apiKey: '' # 模型 API Key；默认使用 DeepSeek
`;

const provided = value =>
  (typeof value === 'string' && Boolean(value.trim()) && !/^<.*>$/.test(value.trim())) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (name, status, message) => ({ name, status, message });
export const supportsNodeVersion = (version = process.versions.node) => {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
};

// Do not import the framework here: doctor must not start watchers, adapters,
// Redis clients, model requests or Python installation.
export const inspectConfig = (value, options) => {
  if (!object(value)) return [check('config', 'error', '配置应为 YAML 对象，请保留各配置项的缩进。')];
  const agent = value[packageInfo.name];
  const qq = { ...(object(value['qq-bot']) ? value['qq-bot'] : {}), ...(object(value['@alemonjs/qq-bot']) ? value['@alemonjs/qq-bot'] : {}) };
  const checks = [];
  const credentials = [[`${packageInfo.name}.apiKey`, agent?.apiKey, false]];
  if (agent?.transport === 'onebot') {
    try {
      resolveOneBotConfig(value);
      checks.push(check('onebot', 'ok', 'OneBot 配置有效，在线状态以连接与账号核验为准。'));
    } catch (error) {
      checks.push(check('onebot', 'error', error.message));
    }
  } else if (object(qq.bots) && Object.keys(qq.bots).length) {
    for (const [id, bot] of Object.entries(qq.bots)) {
      credentials.push(['qq-bot.bots.*.secret', bot?.secret, false]);
      if (!id.trim() || (bot?.app_id && String(bot.app_id) !== id)) checks.push(check('qq-bot.bots', 'error', 'bots 的账号键需要与对应 AppID 一致。'));
    }
    if ((Object.keys(qq.bots).length > 1 && !qq.default_bot) || (qq.default_bot && !Object.hasOwn(qq.bots, qq.default_bot)))
      checks.push(check('qq-bot.default_bot', 'error', '请将 default_bot 设置为 bots 中的一个 AppID。'));
  } else if (provided(qq.app_id) || provided(qq.secret)) {
    credentials.push(['qq-bot.app_id', qq.app_id, true], ['qq-bot.secret', qq.secret, false]);
  } else {
    checks.push(check('qq-login', 'info', '尚无 QQ 凭证，启动后扫码授权；已有机器人可直接填写 AppID 和密钥。'));
  }
  for (const [name, candidate, numeric] of credentials) {
    checks.push(
      check(
        name,
        provided(candidate) && (numeric || typeof candidate === 'string') ? 'ok' : 'error',
        provided(candidate) && (numeric || typeof candidate === 'string') ? `${name} 已填写。` : `请填写 ${name}。`
      )
    );
  }
  try {
    resolveDSHConfig(agent, { ...options, hasRedis: Boolean(value.db?.redis) });
  } catch (error) {
    checks.push(check('agent-config', 'error', error.message));
  }
  return checks;
};

const writableAncestor = async path => {
  let candidate = path;
  while (true) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) return false;
      await access(candidate, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(candidate) === candidate) return false;
      candidate = dirname(candidate);
    }
  }
};

export const diagnose = async (options = {}) => {
  const cwd = options.cwd ?? process.cwd();
  const { configPath, dataRoot } = await launchPaths(options);
  const checks = [];
  checks.push(check('node', supportsNodeVersion() ? 'ok' : 'error', `Node.js ${process.versions.node}；需要 22.13 或更高版本。`));
  if (checks[0].status === 'ok') {
    const sqlite = spawnSync(process.execPath, ['--input-type=module', '-e', "try { await import('node:sqlite'); } catch { process.exit(1); }"], {
      stdio: 'ignore',
      timeout: 5000
    });
    checks.push(
      check(
        'sqlite',
        sqlite.status === 0 ? 'ok' : 'error',
        sqlite.status === 0 ? '内置 SQLite 可用。' : '当前 Node 不提供内置 SQLite，请安装支持该功能的 Node 22.13 或更高版本。'
      )
    );
  }
  let config;
  try {
    const lineCounter = new LineCounter();
    const document = parseDocument(await readFile(configPath, 'utf8'), { prettyErrors: false, uniqueKeys: true, lineCounter });
    if (document.errors.length) {
      // YAML parser errors can contain source lines with secrets. Only report location.
      const position = document.errors[0].pos?.[0];
      const line = typeof position === 'number' ? lineCounter.linePos(position).line : undefined;
      checks.push(check('config', 'error', `配置 YAML 格式有误${line ? `，请检查第 ${line} 行` : '，请检查缩进或重复配置项'}。`));
    } else {
      config = document.toJS({ maxAliasCount: 50 });
      checks.push(...inspectConfig(config, { cwd, configPath, dataRoot }));
    }
  } catch (error) {
    checks.push(check('config', 'error', error.code === 'ENOENT' ? '尚无配置文件；运行启动命令会自动生成。' : '无法读取配置，请检查文件权限和 YAML 格式。'));
  }
  const agent = object(config?.[packageInfo.name]) ? config[packageInfo.name] : {};
  let resolved;
  try {
    resolved = resolveDSHConfig(config?.[packageInfo.name], { cwd, configPath, dataRoot, hasRedis: Boolean(config?.db?.redis) });
  } catch {
    /* Reported above. */
  }
  const dataPath = resolved ? dirname(resolved.dshHomeRoot) : dataRoot;
  const writable = await writableAncestor(dataPath);
  checks.push(check('data', writable ? 'ok' : 'error', writable ? '数据目录可写。' : '数据目录不可写，请把应用放到当前用户可写的目录。'));
  const backend = agent.stateBackend ?? (config?.db?.redis ? 'redis' : 'local');
  checks.push(check('state', 'info', backend === 'redis' ? '使用已有 Redis 配置；离线检查不验证连接。' : '使用本地持久化，无需安装 Redis。'));
  checks.push(
    check(
      'runtime',
      'info',
      agent.runtimeMode === 'chat-only'
        ? '已选择普通聊天，不会自动安装 Agent 沙箱环境。'
        : agent.runtimeMode === 'sandbox'
          ? '已要求完整沙箱；启动时会尝试安装依赖并验证 Python 和系统沙箱。'
          : '启动后会尝试自动准备 Agent 环境；准备期间或失败时保留普通聊天。'
    )
  );
  if (agent.runtimeMode !== 'chat-only') {
    const issue = agentPlatformIssue();
    checks.push(check('agent-platform', issue ? (agent.runtimeMode === 'sandbox' ? 'error' : 'info') : 'ok', issue || '系统版本与架构符合 Agent 运行包要求；安装、沙箱权限与模型连接仍需启动验证。'));
  }
  return { ok: !checks.some(item => item.status === 'error'), configPath, dataRoot, platform: process.platform, arch: process.arch, checks };
};

const ensureConfig = async path => {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, minimalConfig, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
};

export const runCLI = async (argv, { cwd = process.cwd(), write = text => process.stdout.write(`${text}\n`), start, homeDir, env = process.env } = {}) => {
  let command = 'start';
  let configPath;
  let portable = false;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['start', 'init', 'doctor'].includes(arg) && index === 0) command = arg;
    else if (arg === '--config' && argv[index + 1] && !argv[index + 1].startsWith('-')) configPath = resolve(cwd, argv[++index]);
    else if (arg === '--json') json = true;
    else if (arg === '--portable') portable = true;
    else if (arg === '--login' && argv[index + 1] === 'qq-bot') index++;
    else if (arg === '--help' || arg === '-h') {
      write('AgentLink：在仓库运行 npm start、npm run init 或 npm run doctor。\n附加参数放在 -- 后，例如 npm start -- --portable、npm run doctor -- --json。首次启动自动生成配置。');
      return 0;
    } else {
      write('无法识别参数。运行 agent-link --help 查看用法。');
      return 2;
    }
  }
  try {
    const paths = await launchPaths({ cwd, configPath, portable, homeDir, env });
    configPath = paths.configPath;
    if (command !== 'doctor') {
      if (!supportsNodeVersion()) {
        write(`当前 Node.js ${process.versions.node} 不受支持，请升级到 Node.js 22.13 或更高版本后重试。`);
        return 1;
      }
      const created = await ensureConfig(configPath);
      if (created || command === 'init') {
        write(`${created ? '已生成最小配置' : '配置已存在'}：${configPath}\n填写模型 API Key 后重跑同一命令；QQ 可扫码登录，也可填写已有 AppID 和密钥。`);
        return created && command === 'start' ? 2 : 0;
      }
    }
    const report = await diagnose({ cwd, configPath, homeDir, env });
    if (command === 'doctor') {
      write(
        json
          ? JSON.stringify(report, null, 2)
          : [
              report.ok ? '本地检查通过，模型和 QQ 连接需实际启动验证。' : '请先处理以下配置或环境问题：',
              `配置文件：${configPath}`,
              `数据目录：${report.dataRoot}`,
              ...report.checks.map(item => `${item.status === 'error' ? '×' : item.status === 'ok' ? '✓' : '·'} ${item.message}`)
            ].join('\n')
      );
      return report.ok ? 0 : 1;
    }
    if (!report.ok) {
      write(
        [
          `请修改配置：${configPath}`,
          ...report.checks.filter(item => item.status === 'error').map(item => `- ${item.message}`),
          '保存后再次运行同一条启动命令。'
        ].join('\n')
      );
      return 2;
    }
    const value = parseDocument(await readFile(configPath, 'utf8')).toJS();
    const resolved = resolveDSHConfig(value[packageInfo.name], { cwd, configPath, dataRoot: paths.dataRoot, hasRedis: Boolean(value.db?.redis) });
    const ownership = await acquireProcessLock(join(dirname(resolved.dshHomeRoot), 'launcher.lock'));
    try {
      await mkdir(paths.homeDir, { recursive: true, mode: 0o700 });
      const profilePath = join(paths.homeDir, 'active-profile.json');
      const temporaryProfile = `${profilePath}.${randomUUID()}.tmp`;
      await writeFile(temporaryProfile, JSON.stringify({ configPath }), { mode: 0o600, flush: true });
      await rename(temporaryProfile, profilePath);
      if (start) {
        try {
          await start({ configPath, cwd, dataRoot: paths.dataRoot });
        } finally {
          await ownership.release();
        }
      } else {
        await launchRuntime({ cwd, configPath, dataRoot: paths.dataRoot, runtimeRoot: dirname(resolved.dshHomeRoot), write, ownership });
      }
    } catch (error) {
      await ownership.release();
      throw error;
    }
    return 0;
  } catch (error) {
    if (error.code === 'ABORT_ERR') return 130;
    if (error.code === 'ELOCKLOST') {
      write('实例已停止。请确认数据目录没有被移动或删除，再重新启动。');
      return 1;
    }
    if (error.code === 'ERUNTIME' || error.code === 'ERUNTIME_TIMEOUT') {
      write(`启动未完成，请检查 QQ 授权、网络或严格沙箱配置。诊断日志：${error.logPath}`);
      return 1;
    }
    if (error.code === 'ELOCKED') {
      write('机器人已在运行或正在准备，请使用已有实例；异常退出后稍等几秒再试。');
      return 1;
    }
    const permission = error.code === 'EACCES' || error.code === 'EPERM';
    write(
      permission
        ? '无法访问启动文件或配置目录，请使用当前用户可写的目录后重试。'
        : '启动未完成。请运行 npm run doctor 检查配置，并确认使用包含 lib 构建产物的完整安装包。'
    );
    return 1;
  }
};
