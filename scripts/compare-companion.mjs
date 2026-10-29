import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const corpusUrl = new URL('../benchmarks/companion-scenarios.json', import.meta.url);
export const corpusFingerprint = corpus => createHash('sha256').update(JSON.stringify(corpus)).digest('hex');
const dimensions = ['naturalness', 'continuity', 'grounding'];

export const comparisonTemplate = corpus => ({
  subject: '',
  model: '',
  settings: '',
  generationEvidence: '',
  corpusHash: corpusFingerprint(corpus),
  responses: corpus.cases.map(item => ({ id: item.id, kind: null, response: null, latencyMs: null, reviewer: '', reviewNote: '', scores: null }))
});

export const summarizeComparison = (corpus, submitted) => {
  if (submitted.corpusHash !== corpusFingerprint(corpus)) throw new Error('场景版本不同，不能合并比较。');
  if (!Array.isArray(submitted.responses)) throw new Error('缺少 responses。');
  const expected = new Set(corpus.cases.map(item => item.id));
  const seen = new Set();
  const complete = [];
  const pending = [];
  for (const row of submitted.responses) {
    if (!expected.has(row.id) || seen.has(row.id)) throw new Error('存在未知或重复的场景编号。');
    seen.add(row.id);
    if (row.kind == null || row.response == null || row.scores == null || !row.reviewer?.trim() || !row.reviewNote?.trim()) {
      pending.push(row.id);
      continue;
    }
    if (!['text', 'silence', 'media'].includes(row.kind) || typeof row.response !== 'string') throw new Error('回复类型无效。');
    if (row.kind === 'silence' && row.response !== '') throw new Error('沉默不能附带已发送正文。');
    if (row.kind !== 'silence' && !row.response.trim()) throw new Error('文字或媒体需要实际回复或证据说明。');
    if (row.latencyMs !== null && (!Number.isFinite(row.latencyMs) || row.latencyMs < 0)) throw new Error('延迟需要非负毫秒值或 null。');
    if (dimensions.some(key => !Number.isInteger(row.scores[key]) || row.scores[key] < 1 || row.scores[key] > 5)) throw new Error('每项评分需要 1–5 的整数。');
    complete.push(row);
  }
  for (const id of expected) if (!seen.has(id)) pending.push(id);
  const latency = complete
    .map(row => row.latencyMs)
    .filter(value => value !== null)
    .sort((a, b) => a - b);
  const percentile = ratio => (latency.length ? latency[Math.ceil(latency.length * ratio) - 1] : null);
  const pendingMetadata = ['subject', 'model', 'settings', 'generationEvidence'].filter(key => typeof submitted[key] !== 'string' || !submitted[key].trim());
  const ready = !pending.length && !pendingMetadata.length;
  return {
    subject: submitted.subject || '未填写',
    declaredModel: submitted.model || '未填写',
    corpusHash: submitted.corpusHash,
    status: ready ? 'reviewed' : 'pending',
    expected: expected.size,
    reviewed: complete.length,
    pending,
    pendingMetadata,
    scores: Object.fromEntries(
      dimensions.map(key => [key, complete.length ? Number((complete.reduce((sum, row) => sum + row.scores[key], 0) / complete.length).toFixed(2)) : null])
    ),
    latency: { samples: latency.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95) },
    notice: '仅汇总提交的回复与评审，未核实生成环境或评分者身份。缺项不计零分；不同模型、设置或评审者的分数不能直接证明产品优劣。报告不包含回复正文。'
  };
};

const main = async () => {
  const corpus = JSON.parse(await readFile(corpusUrl, 'utf8'));
  const args = process.argv.slice(2);
  if (args[0] === '--template' && args.length === 2) {
    await writeFile(args[1], JSON.stringify(comparisonTemplate(corpus), null, 2) + '\n', { flag: 'wx' });
    return;
  }
  if (!args.length || args.includes('--help')) {
    process.stdout.write(
      '生成评分表：node scripts/compare-companion.mjs --template /绝对路径/sample.json\n汇总：node scripts/compare-companion.mjs /绝对路径/fish.json /绝对路径/reference.json\n场景：benchmarks/companion-scenarios.json；脚本不调用模型，不连接 QQ。\n'
    );
    return;
  }
  const report = [];
  for (const path of args) report.push(summarizeComparison(corpus, JSON.parse(await readFile(path, 'utf8'))));
  process.stdout.write(JSON.stringify({ corpusSource: corpus.source, report }, null, 2) + '\n');
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
