import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';

export const redact = (text, config = {}) => {
  const secrets = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/api.?key|secret|password|authorization|token/i.test(key) && typeof item === 'string' && item) {
        secrets.push(item);
        if (item.trim()) secrets.push(item.trim());
      } else if (item && typeof item === 'object') walk(item);
    }
  };
  walk(config);
  let output = String(text);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) output = output.split(secret).join('[已隐藏]');
  return output
    .replace(/Bearer\s+[^\s'",}]+/gi, 'Bearer [已隐藏]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/([?&](?:token|key|api_key|password|secret)=)[^\s&#]+/gi, '$1[已隐藏]');
};

export const appendDiagnostic = (path, text, configPath = process.env.CFG_PATH) => {
  try {
    let config = {};
    if (configPath) {
      try {
        config = parseDocument(readFileSync(configPath, 'utf8')).toJS();
      } catch {
        return;
      }
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size > 1024 * 1024) renameSync(path, `${path}.1`);
    } catch {
      /* No previous log. */
    }
    appendFileSync(path, redact(String(text), config).slice(-16000) + '\n', { mode: 0o600 });
  } catch {
    /* Logging must not interrupt shutdown. */
  }
};

export const captureLines = (stream, path, configPath) => {
  let pending = '';
  stream?.setEncoding('utf8');
  stream?.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) appendDiagnostic(path, line.length > 16000 ? '[日志行过长，已省略]' : line, configPath);
    if (pending.length > 16000) pending = '[日志行过长，已省略]';
  });
  stream?.on('end', () => {
    if (pending) appendDiagnostic(path, pending, configPath);
  });
};
