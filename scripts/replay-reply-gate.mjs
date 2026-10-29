#!/usr/bin/env node
/**
 * 用真实聊天归档回放新的 replyGate，不连接 QQ、不写会话、不启动 DSH。
 *
 * 这是“真实群聊验收”的离线半场：消息来自真实群，判断来自新分类器。
 * 仍然需要在线上群做一次发送/不发送的现场验收，见 docs/dafeiyu-live-validation.md。
 *
 * 用法：
 *   node scripts/replay-reply-gate.mjs --limit 20 --activity active
 *   node scripts/replay-reply-gate.mjs --limit 50 --hours 6 --activity balanced --show
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parse } from 'yaml';
import { resolveDSHConfig } from '../lib/dsh/config.js';
import { classifyGroupReply } from '../lib/social/reply-gate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg.startsWith('--')) {
    const [key, inline] = arg.slice(2).split('=', 2);
    args.set(key, inline ?? process.argv[index + 1] ?? 'true');
    if (inline === undefined && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) index++;
  }
}
const numberArg = (name, fallback, min, max) => {
  const value = Number(args.get(name) ?? fallback);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
};
const limit = numberArg('limit', 20, 1, 200);
const hours = numberArg('hours', 24, 1, 24 * 30);
const configPath = resolve(root, String(args.get('config') || 'alemon.config.yaml'));
const databasePath = resolve(root, String(args.get('data') || '.data/agent-link/chat-history.sqlite'));
const outPath = resolve(root, String(args.get('out') || `.data/agent-link/validation/gate-replay-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`));
const scopeFilter = args.get('scope') || '';
const show = args.has('show');
const timeoutMs = numberArg('timeout', 8000, 1000, 30000);
const requestedActivity = String(args.get('activity') || 'active');
const activity = ['quiet', 'balanced', 'active'].includes(requestedActivity) ? requestedActivity : 'active';

const config = parse(await readFile(configPath, 'utf8'));
const namespace = config?.['alemonjs-agent-link'];
if (!namespace || typeof namespace !== 'object') throw new Error('配置缺少 alemonjs-agent-link');

// 回放只读：关闭预算与 Redis 依赖，不消耗群账本，也不写入任何会话。
const replayConfig = structuredClone(config);
replayConfig['alemonjs-agent-link'].budget = { ...(replayConfig['alemonjs-agent-link'].budget || {}), enabled: false };
replayConfig['alemonjs-agent-link'].aiEnabled = true;
globalThis.__config = { value: replayConfig };

const resolved = resolveDSHConfig(replayConfig);
const wakeNames = resolved.groupWakeNames;
const db = new DatabaseSync(databasePath, { readOnly: true });
const since = Date.now() - hours * 3600_000;
const params = ['user', since, ''];
let where = 'role=? AND timestamp>=? AND text<>?';
if (scopeFilter) {
  where += ' AND scope=?';
  params.push(scopeFilter);
}
const targets = db
  .prepare(`SELECT seq,scope,speaker_id,speaker,text,timestamp FROM messages WHERE ${where} ORDER BY seq DESC LIMIT ?`)
  .all(...params, limit * 3)
  .reverse()
  .slice(-limit);

const contextFor = (scope, seq) =>
  db
    .prepare('SELECT seq,speaker_id,role,text FROM messages WHERE scope=? AND seq<? ORDER BY seq DESC LIMIT 5')
    .all(scope, seq)
    .reverse();

const calledBy = (text) => wakeNames.some(name => text.toLocaleLowerCase().includes(String(name).toLocaleLowerCase()));
const latency = [];
const results = [];
const totals = {
  inspected: 0,
  reply: 0,
  silent: 0,
  addressed: {},
  related: {},
  sources: {},
  loopRisk: 0,
  errors: 0,
  budgetBlocked: 0
};

for (const target of targets) {
  if (typeof target.text !== 'string' || !target.text.trim() || target.text.startsWith('/')) continue;
  const prior = contextFor(target.scope, target.seq);
  const speakers = new Map();
  const alias = (id, role) => {
    if (role === 'assistant') return 'bot';
    if (!speakers.has(id)) speakers.set(id, `u${speakers.size + 1}`);
    return speakers.get(id);
  };
  const input = {
    activity,
    recent: prior.map(item => ({ speaker: alias(item.speaker_id, item.role), text: String(item.text).slice(0, 400) })),
    messages: [
      {
        speaker: alias(target.speaker_id, 'user'),
        text: target.text.slice(0, 2000),
        called: calledBy(target.text),
        trigger: 'ambient',
        mentionsKnown: false,
        mentions: [],
        references: '',
        media: []
      }
    ]
  };
  const started = Date.now();
  let verdict;
  try {
    verdict = await classifyGroupReply(input, AbortSignal.timeout(timeoutMs));
  } catch (error) {
    totals.errors++;
    results.push({ seq: target.seq, scope: String(target.scope).slice(0, 12), chars: target.text.length, error: error instanceof Error ? error.name : 'Error' });
    continue;
  }
  const ms = Date.now() - started;
  latency.push(ms);
  totals.inspected++;
  if (verdict.reply) totals.reply++;
  else totals.silent++;
  totals.addressed[verdict.addressed] = (totals.addressed[verdict.addressed] || 0) + 1;
  totals.related[verdict.related] = (totals.related[verdict.related] || 0) + 1;
  totals.sources[verdict.source || 'unknown'] = (totals.sources[verdict.source || 'unknown'] || 0) + 1;
  if (verdict.loopRisk) totals.loopRisk++;
  if (verdict.budgetBlocked) totals.budgetBlocked++;
  const row = {
    seq: target.seq,
    scope: String(target.scope).slice(0, 12),
    chars: target.text.length,
    called: calledBy(target.text),
    reply: verdict.reply,
    addressed: verdict.addressed,
    related: verdict.related,
    reason: verdict.reason,
    source: verdict.source || 'unknown',
    loopRisk: Boolean(verdict.loopRisk),
    budgetBlocked: Boolean(verdict.budgetBlocked),
    ms
  };
  if (show) row.text = target.text.slice(0, 120);
  results.push(row);
  process.stdout.write(`\r${totals.inspected}/${targets.length}`);
}
process.stdout.write('\n');

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const report = {
  generatedAt: new Date().toISOString(),
  source: { database: databasePath, scope: scopeFilter || null, windowHours: hours },
  gate: { model: resolved.replyGate?.model || resolved.model || null, wakeNameCount: wakeNames.length, timeoutMs, activity },
  totals,
  latencyMs: { p50: percentile(latency, 50), p95: percentile(latency, 95), max: latency.length ? Math.max(...latency) : null },
  samples: results
};
await mkdir(dirname(outPath), { recursive: true, mode: 0o700 });
await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      report: outPath,
      activity,
      inspected: totals.inspected,
      reply: totals.reply,
      silent: totals.silent,
      addressed: totals.addressed,
      related: totals.related,
      sources: totals.sources,
      errors: totals.errors,
      budgetBlocked: totals.budgetBlocked,
      latencyMs: report.latencyMs
    },
    null,
    2
  )
);
db.close();
