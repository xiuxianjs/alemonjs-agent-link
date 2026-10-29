#!/usr/bin/env node
/**
 * 从 command 日志里汇总新的 replyGate、fast path、回复质检指标。
 * 只读日志，不包含消息正文；输出聚合 JSON，便于复盘。
 *
 * 用法：
 *   node scripts/live-gate-metrics.mjs
 *   node scripts/live-gate-metrics.mjs --file logs/command.2026-10-28.log
 */
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let index = 2; index < process.argv.length; index++) {
  const value = process.argv[index];
  if (value.startsWith('--')) {
    const [key, inline] = value.slice(2).split('=', 2);
    args.set(key, inline ?? process.argv[index + 1] ?? 'true');
    if (inline === undefined && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) index++;
  }
}
const latestLog = async () => {
  const names = (await readdir(join(root, 'logs')))
    .filter(name => /^command\.\d{4}-\d{2}-\d{2}\.log$/u.test(name))
    .sort();
  if (!names.length) throw new Error('没有找到 command 日志。');
  return join(root, 'logs', names.at(-1));
};
const file = args.get('file') ? resolve(root, String(args.get('file'))) : await latestLog();
const text = await readFile(file, 'utf8');
const start = text.indexOf("addressed: '");
const section = start >= 0 ? text.slice(start) : text;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const verdictPattern =
  /\{[^{}]*?reply:\s*(true|false),?[^{}]*?addressed:\s*'([^']+)'[^{}]*?related:\s*'([^']+)'[^{}]*?reason:\s*'([^']+)'[^{}]*?source:\s*'([^']+)'[^{}]*?loopRisk:\s*(true|false)[^{}]*?called:\s*(true|false)[^{}]*?\}\s*Group reply gate verdict/gu;
const latencyPattern = /\{([^{}]*?gateMs:\s*(\d+)[^{}]*?)\}\s*Group reply latency/gu;
const verdicts = [];
for (const match of section.matchAll(verdictPattern)) {
  verdicts.push({ reply: match[1] === 'true', addressed: match[2], related: match[3], reason: match[4], source: match[5], loopRisk: match[6] === 'true', called: match[7] === 'true' });
}
const latencies = [];
for (const match of section.matchAll(latencyPattern)) {
  const body = match[1];
  const gateMs = Number(match[2]);
  const bypassed = /bypassed:\s*true/u.test(body);
  const fastPath = /fastPath:\s*true/u.test(body);
  const lowSignal = /lowSignal:\s*true/u.test(body);
  const localSkip = /localSkip:\s*true/u.test(body);
  latencies.push({ gateMs, bypassed, fastPath, lowSignal, localSkip });
}
const count = (items, part) =>
  items.reduce((result, item) => {
    const key = part(item);
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
const gateLatencies = latencies.filter(item => item.gateMs > 0).map(item => item.gateMs);
const report = {
  generatedAt: new Date().toISOString(),
  file,
  verdicts: {
    total: verdicts.length,
    replies: verdicts.filter(item => item.reply).length,
    silent: verdicts.filter(item => !item.reply).length,
    addressed: count(verdicts, item => item.addressed),
    related: count(verdicts, item => item.related),
    sources: count(verdicts, item => item.source),
    loopRisk: verdicts.filter(item => item.loopRisk).length,
    called: verdicts.filter(item => item.called).length
  },
  latency: {
    totalCalls: latencies.length,
    gateCalls: gateLatencies.length,
    fastPath: latencies.filter(item => item.fastPath).length,
    bypassed: latencies.filter(item => item.bypassed).length,
    lowSignal: latencies.filter(item => item.lowSignal).length,
    localSkip: latencies.filter(item => item.localSkip).length,
    gateP50: percentile(gateLatencies, 50),
    gateP95: percentile(gateLatencies, 95),
    gateMax: gateLatencies.length ? Math.max(...gateLatencies) : null
  },
  polish: {
    polished: (section.match(/Social reply polished/gu) || []).length,
    trimmed: (section.match(/Social reply trimmed/gu) || []).length
  },
  contradictions: {
    replyWithoutAddressOrRelation: verdicts.filter(item => item.reply && item.addressed === 'none' && item.related === 'none').length,
    silentWithAddressOrRelation: verdicts.filter(item => !item.reply && (item.addressed !== 'none' || item.related !== 'none')).length,
    loopRiskReply: verdicts.filter(item => item.loopRisk && item.reply).length
  }
};
const out = resolve(root, `.data/agent-link/validation/live-metrics-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ...report, report: out }, null, 2));
