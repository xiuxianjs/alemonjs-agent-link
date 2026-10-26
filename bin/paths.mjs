import { access, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const exists = path =>
  access(path).then(
    () => true,
    () => false
  );
export const launchPaths = async ({ cwd = process.cwd(), configPath, portable = false, homeDir, env = process.env } = {}) => {
  const home = resolve(
    homeDir ||
      env.AGENT_LINK_HOME ||
      (process.platform === 'win32'
        ? join(env.APPDATA || homedir(), 'AgentLink')
        : process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Application Support', 'AgentLink')
          : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agent-link'))
  );
  let selected = configPath || env.CFG_PATH;
  if (!selected) {
    const local = join(cwd, 'alemon.config.yaml');
    if (portable || (await exists(local)) || (await exists(join(cwd, '.data', 'agent-link')))) selected = local;
    else {
      try {
        const remembered = JSON.parse(await readFile(join(home, 'active-profile.json'), 'utf8'));
        if (typeof remembered.configPath === 'string' && (await exists(remembered.configPath))) selected = remembered.configPath;
      } catch {
        /* First run. */
      }
      selected ||= join(home, 'alemon.config.yaml');
    }
  }
  selected = resolve(cwd, selected);
  const dataRoot = env.AGENT_LINK_DATA_DIR
    ? resolve(cwd, env.AGENT_LINK_DATA_DIR)
    : dirname(selected) === home
      ? join(home, 'data')
      : join(dirname(selected), '.data', 'agent-link');
  return { configPath: selected, dataRoot, homeDir: home };
};
