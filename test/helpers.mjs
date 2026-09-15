import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test gets its own AGENT_BRIDGE_HOME. The modules read that variable at
 * call time rather than import time, so setting it per test is enough to keep
 * runs isolated from each other and from the developer's real bridge.
 */
export function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
  process.env.AGENT_BRIDGE_HOME = dir;
  return dir;
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENT_BRIDGE_HOME;
}

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
