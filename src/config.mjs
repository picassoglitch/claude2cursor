/**
 * Optional per-user settings and peer-CLI discovery.
 *
 * The bridge needs no credentials of any kind, so there is nothing here a user
 * *must* set. This exists so the handful of optional preferences (which channel,
 * where the peer CLIs live) can be saved once instead of exported into every
 * shell.
 *
 * Every setting resolves: environment variable > ~/.agent-bridge/config.json >
 * auto-detection > built-in default.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function home() {
  return process.env.AGENT_BRIDGE_HOME || path.join(os.homedir(), '.agent-bridge');
}

export const configPath = () => path.join(home(), 'config.json');

/** key -> { env, def, describe } */
export const SETTINGS = {
  channel: { env: 'AGENT_BRIDGE_CHANNEL', def: 'default', describe: 'conversation to join ("auto" = per git repo)' },
  'claude-cmd': { env: 'AGENT_BRIDGE_CLAUDE_CMD', def: null, describe: 'path to the Claude Code CLI' },
  'cursor-cmd': { env: 'AGENT_BRIDGE_CURSOR_CMD', def: null, describe: 'path to the Cursor CLI' },
  'claude-args': { env: 'AGENT_BRIDGE_CLAUDE_ARGS', def: '', describe: 'extra args for headless Claude Code' },
  'cursor-args': { env: 'AGENT_BRIDGE_CURSOR_ARGS', def: '', describe: 'extra args for headless Cursor' },
};

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

export function saveConfig(cfg) {
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Effective value plus where it came from, for `config` and `doctor` to show. */
export function setting(key) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`unknown setting "${key}" (try: ${Object.keys(SETTINGS).join(', ')})`);
  const fromEnv = spec.env && process.env[spec.env];
  if (fromEnv) return { value: fromEnv, source: `env ${spec.env}` };
  const fromFile = loadConfig()[key];
  if (fromFile) return { value: fromFile, source: 'config' };
  return { value: spec.def, source: 'default' };
}

const isExe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

const onPath = (bin) => (process.env.PATH || '').split(path.delimiter)
  .map((d) => path.join(d, bin))
  .find((p) => isExe(p)) || null;

/**
 * Both CLIs are commonly installed somewhere that is on an interactive shell's
 * PATH but not on the PATH an editor hands to a spawned MCP server, so check the
 * usual install locations before giving up.
 */
function candidates(bin) {
  const h = os.homedir();
  const common = [
    path.join(h, '.local', 'bin', bin),
    path.join(h, 'bin', bin),
    `/usr/local/bin/${bin}`,
    `/opt/homebrew/bin/${bin}`,
  ];
  const perTool = bin === 'claude'
    ? [path.join(h, '.claude', 'local', bin)]
    : [
      path.join(h, '.cursor', 'bin', bin),
      `/Applications/Cursor.app/Contents/Resources/app/bin/${bin}`,
    ];
  return [...common, ...perTool];
}

/**
 * Locate a peer CLI. `kind` is "claude" or "cursor".
 * Returns { command, source } — command may be the bare name as a last resort,
 * which lets the caller surface a clear ENOENT rather than guessing.
 */
export function resolveBinary(kind) {
  const key = kind === 'claude' ? 'claude-cmd' : 'cursor-cmd';
  const configured = setting(key);
  if (configured.value) {
    // An explicit setting is honoured either way, but say so when it is broken
    // rather than reporting a path that cannot run as healthy.
    const usable = configured.value.includes(path.sep)
      ? isExe(configured.value)
      : !!onPath(configured.value);
    return {
      command: configured.value,
      source: usable ? configured.source : `${configured.source}, MISSING`,
      usable,
    };
  }

  const bin = kind === 'claude' ? 'claude' : 'cursor-agent';
  const found = onPath(bin);
  if (found) return { command: bin, source: 'PATH', usable: true };
  const guess = candidates(bin).find(isExe);
  if (guess) return { command: guess, source: 'auto-detected', usable: true };
  return { command: bin, source: 'not found', usable: false };
}
