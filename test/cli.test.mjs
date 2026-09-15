import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { sandbox, cleanup, REPO } from './helpers.mjs';

const BIN = path.join(REPO, 'bin', 'agent-bridge.mjs');
let dir;
beforeEach(() => { dir = sandbox(); });
afterEach(() => cleanup(dir));

function cli(args, { channel = 'test', cwd = REPO } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args, '--channel', channel], {
      env: { ...process.env, AGENT_BRIDGE_HOME: dir }, cwd,
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}

test('bare invocation prints usage and exits 0', async () => {
  const { code, stdout } = await new Promise((resolve) => {
    execFile(process.execPath, [BIN], { env: { ...process.env, AGENT_BRIDGE_HOME: dir } },
      (err, out) => resolve({ code: err?.code ?? 0, stdout: out }));
  });
  assert.equal(code, 0);
  assert.match(stdout, /two-way link between Claude Code and Cursor/);
});

test('an unknown command prints usage and exits non-zero', async () => {
  const { code, stdout } = await cli(['not-a-command']);
  assert.equal(code, 2);
  assert.match(stdout, /agent-bridge —/);
});

test('the bin entrypoint loads the CLI through its relative import', async () => {
  const { code, stdout } = await cli(['channel']);
  assert.equal(code, 0);
  assert.match(stdout, /channel: test/);
});

test('channel reports where the transcript lives', async () => {
  const { stdout } = await cli(['channel']);
  assert.match(stdout, /storage: /);
  assert.ok(stdout.includes(dir), 'storage must sit under AGENT_BRIDGE_HOME');
});

test('send then inbox carries a message between roles', async () => {
  const sent = await cli(['send', '--as', 'claude', 'hello from the cli']);
  assert.match(sent.stdout, /sent m_[0-9a-f]{8} to cursor/);

  const read = await cli(['inbox', '--as', 'cursor']);
  assert.match(read.stdout, /hello from the cli/);

  const again = await cli(['inbox', '--as', 'cursor']);
  assert.equal(again.stdout.trim(), '', 'a read message is not redelivered');
});

test('--peek leaves the message unread', async () => {
  await cli(['send', '--as', 'claude', 'peek target']);
  const peeked = await cli(['inbox', '--as', 'cursor', '--peek']);
  assert.match(peeked.stdout, /peek target/);
  const real = await cli(['inbox', '--as', 'cursor']);
  assert.match(real.stdout, /peek target/, 'peek must not consume');
});

test('--to routes a message explicitly', async () => {
  await cli(['send', '--as', 'claude', '--to', 'cursor', 'explicitly addressed']);
  const read = await cli(['inbox', '--as', 'cursor']);
  assert.match(read.stdout, /explicitly addressed/);
});

test('--type is preserved and rendered', async () => {
  await cli(['send', '--as', 'claude', '--type', 'question', 'typed message']);
  const read = await cli(['inbox', '--as', 'cursor']);
  assert.match(read.stdout, /\(question\)/);
});

test('an invalid --as role is rejected', async () => {
  const { code, stderr } = await cli(['send', '--as', 'nobody', 'text']);
  assert.equal(code, 2);
  assert.match(stderr, /--as must be one of claude\|cursor/);
});

test('peers lists both sides once each has spoken', async () => {
  await cli(['send', '--as', 'claude', 'x']);
  await cli(['inbox', '--as', 'cursor']);
  const { stdout } = await cli(['peers']);
  assert.match(stdout, /claude/);
  assert.match(stdout, /cursor/);
});

test('peers is explicit when the channel is empty', async () => {
  const { stdout } = await cli(['peers']);
  assert.match(stdout, /nobody attached yet/);
});

test('--thread answers a question in its own thread', async () => {
  const sent = await cli(['send', '--as', 'claude', '--type', 'question', 'what?']);
  const thread = sent.stdout.match(/thread (t_[0-9a-f]{8})/)[1];

  await cli(['send', '--as', 'cursor', '--thread', thread, '--type', 'answer', 'this']);
  const read = await cli(['inbox', '--as', 'claude']);
  assert.match(read.stdout, /this/);
  assert.match(read.stdout, new RegExp(`\\{${thread}\\}`));
});

test('ask times out without hanging when nobody answers', async () => {
  const { stdout } = await cli(['ask', '--as', 'claude', '--timeout', '1', 'anyone there?']);
  assert.match(stdout, /no reply \(thread t_[0-9a-f]{8}\)/);
});

test('config lists every setting with its source', async () => {
  const { stdout } = await cli(['config']);
  for (const key of ['channel', 'claude-cmd', 'cursor-cmd', 'claude-args', 'cursor-args']) {
    assert.match(stdout, new RegExp(key));
  }
  assert.match(stdout, /needs no credentials/);
});

test('config set then unset round-trips through the config file', async () => {
  const set = await cli(['config', 'set', 'cursor-cmd', '/tmp/fake-cursor']);
  assert.match(set.stdout, /cursor-cmd = \/tmp\/fake-cursor/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))['cursor-cmd'],
    '/tmp/fake-cursor');

  const shown = await cli(['config']);
  assert.match(shown.stdout, /\/tmp\/fake-cursor\s+config/);

  await cli(['config', 'unset', 'cursor-cmd']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))['cursor-cmd'],
    undefined);
});

test('config rejects an unknown key', async () => {
  const { code, stderr } = await cli(['config', 'set', 'not-a-setting', 'x']);
  assert.equal(code, 2);
  assert.match(stderr, /unknown setting/);
});

test('a configured but missing CLI path is reported as broken', async () => {
  await cli(['config', 'set', 'claude-cmd', '/definitely/not/here']);
  const { stdout } = await cli(['doctor']);
  assert.match(stdout, /MISSING/, 'doctor must not call a dead path healthy');
});

test('doctor reports on registration and attachment', async () => {
  const { stdout } = await cli(['doctor']);
  assert.match(stdout, /agent-bridge on PATH/);
  assert.match(stdout, /Cursor registered/);
  assert.match(stdout, /Claude Code registered/);
  assert.match(stdout, /attached:/);
});

test('install --project writes both editor configs', async () => {
  const proj = fs.mkdtempSync(path.join(dir, 'proj-'));
  const { stdout } = await cli(['install', '--project', proj]);
  assert.match(stdout, /installed for project/);

  const claudeCfg = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  const cursorCfg = JSON.parse(fs.readFileSync(path.join(proj, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(claudeCfg.mcpServers['agent-bridge']);
  assert.ok(cursorCfg.mcpServers['agent-bridge']);
  assert.deepEqual(claudeCfg.mcpServers['agent-bridge'].args.slice(-2), ['--as', 'claude']);
  assert.deepEqual(cursorCfg.mcpServers['agent-bridge'].args.slice(-2), ['--as', 'cursor']);
});

test('install --project preserves unrelated servers already configured', async () => {
  const proj = fs.mkdtempSync(path.join(dir, 'proj-'));
  fs.writeFileSync(path.join(proj, '.mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'keepme' } }, somethingElse: true }));

  await cli(['install', '--project', proj]);
  const cfg = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  assert.equal(cfg.mcpServers.other.command, 'keepme', 'must not clobber other servers');
  assert.equal(cfg.somethingElse, true, 'must not drop unrelated keys');
  assert.ok(cfg.mcpServers['agent-bridge']);
});

test('uninstall --project removes only our entry', async () => {
  const proj = fs.mkdtempSync(path.join(dir, 'proj-'));
  fs.writeFileSync(path.join(proj, '.mcp.json'),
    JSON.stringify({ mcpServers: { other: { command: 'keepme' } } }));
  await cli(['install', '--project', proj]);
  await cli(['uninstall', '--project', proj]);

  const cfg = JSON.parse(fs.readFileSync(path.join(proj, '.mcp.json'), 'utf8'));
  assert.equal(cfg.mcpServers['agent-bridge'], undefined);
  assert.equal(cfg.mcpServers.other.command, 'keepme');
});

test('uninstall is honest when there was nothing to remove', async () => {
  const proj = fs.mkdtempSync(path.join(dir, 'proj-'));
  const { stdout } = await cli(['uninstall', '--project', proj]);
  assert.match(stdout, /not present/);
});

test('clear wipes the transcript', async () => {
  await cli(['send', '--as', 'claude', 'to be cleared']);
  const { stdout } = await cli(['clear']);
  assert.match(stdout, /cleared channel test/);
  const read = await cli(['inbox', '--as', 'cursor']);
  assert.equal(read.stdout.trim(), '');
});

test('channels stay isolated from one another', async () => {
  await cli(['send', '--as', 'claude', 'only in alpha'], { channel: 'alpha' });
  const beta = await cli(['inbox', '--as', 'cursor'], { channel: 'beta' });
  assert.equal(beta.stdout.trim(), '');
  const alpha = await cli(['inbox', '--as', 'cursor'], { channel: 'alpha' });
  assert.match(alpha.stdout, /only in alpha/);
});
