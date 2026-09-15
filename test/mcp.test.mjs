import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, cleanup, REPO } from './helpers.mjs';

const SERVER = path.join(REPO, 'src', 'mcp.mjs');
let dir;
beforeEach(() => { dir = sandbox(); });
afterEach(() => cleanup(dir));

/**
 * Drive the server over a real stdio pipe, exactly as an editor would: write
 * newline-delimited JSON-RPC in, close stdin, collect the responses.
 */
function rpc(requests, { as = 'claude', channel = 'test', home = dir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, '--as', as, '--channel', channel], {
      env: { ...process.env, AGENT_BRIDGE_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const frames = out.split('\n').filter((l) => l.trim());
      let parsed;
      try { parsed = frames.map((l) => JSON.parse(l)); } catch (e) {
        return reject(new Error(`non-JSON on stdout: ${e.message}\nstdout was:\n${out}`));
      }
      resolve({ responses: parsed, stderr: err, code });
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const textOf = (res) => res.result.content[0].text;

test('initialize returns serverInfo and echoes a supported protocol', async () => {
  const { responses } = await rpc([INIT]);
  const r = responses.find((m) => m.id === 1).result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.equal(r.serverInfo.name, 'agent-bridge');
  assert.match(r.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.ok(r.capabilities.tools);
  assert.match(r.instructions, /claude/);
});

test('an unknown protocol version falls back to one we support', async () => {
  const { responses } = await rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
  ]);
  assert.equal(responses[0].result.protocolVersion, '2025-06-18');
});

test('tools/list exposes the full tool set', async () => {
  const { responses } = await rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const names = responses.find((m) => m.id === 2).result.tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'ask_cursor', 'bridge_ask', 'bridge_history',
    'bridge_inbox', 'bridge_peers', 'bridge_send', 'bridge_wait',
  ]);
});

test('every tool declares a usable JSON schema', async () => {
  const { responses } = await rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  for (const t of responses.find((m) => m.id === 2).result.tools) {
    assert.ok(t.description?.length > 20, `${t.name} needs a real description`);
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema must be an object`);
    for (const req of t.inputSchema.required ?? []) {
      assert.ok(t.inputSchema.properties[req], `${t.name} requires undeclared "${req}"`);
    }
  }
});

test('the peer tool is named for the other side', async () => {
  for (const [as, expected] of [['claude', 'ask_cursor'], ['cursor', 'ask_claude']]) {
    const { responses } = await rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }], { as });
    const names = responses.find((m) => m.id === 2).result.tools.map((t) => t.name);
    assert.ok(names.includes(expected), `as ${as} should expose ${expected}`);
    assert.ok(!names.includes(`ask_${as}`), `as ${as} must not expose ask_${as}`);
  }
});

test('bridge_send delivers a message the peer can read', async () => {
  const send = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_send', arguments: { text: 'over the wire' } },
  }], { as: 'claude' });
  assert.match(textOf(send.responses.find((m) => m.id === 2)), /Sent to cursor/);

  const read = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_inbox', arguments: {} },
  }], { as: 'cursor' });
  assert.match(textOf(read.responses.find((m) => m.id === 2)), /over the wire/);
});

test('bridge_inbox says so plainly when nothing is waiting', async () => {
  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_inbox', arguments: {} },
  }]);
  assert.match(textOf(responses.find((m) => m.id === 2)), /No new messages from cursor/);
});

test('bridge_wait honours its timeout instead of hanging', async () => {
  const started = Date.now();
  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_wait', arguments: { timeout_seconds: 1 } },
  }]);
  assert.match(textOf(responses.find((m) => m.id === 2)), /Timed out/);
  assert.ok(Date.now() - started < 10000, 'must not exceed the requested wait by much');
});

test('bridge_peers reports the channel and who is attached', async () => {
  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_peers', arguments: {} },
  }]);
  const text = textOf(responses.find((m) => m.id === 2));
  assert.match(text, /Channel "test"/);
  assert.match(text, /claude \(you\)/);
});

test('bridge_history shows both sides of the conversation', async () => {
  await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_send', arguments: { text: 'first' } },
  }], { as: 'claude' });
  await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_send', arguments: { text: 'second' } },
  }], { as: 'cursor' });

  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_history', arguments: {} },
  }]);
  const text = textOf(responses.find((m) => m.id === 2));
  assert.match(text, /first/);
  assert.match(text, /second/);
});

test('an unknown tool is reported as a tool error, not a crash', async () => {
  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'no_such_tool', arguments: {} },
  }]);
  const r = responses.find((m) => m.id === 2).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Unknown tool/);
});

test('a bad argument surfaces as a tool error', async () => {
  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_send', arguments: {} },
  }]);
  const r = responses.find((m) => m.id === 2).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /text is required/);
});

test('an unknown method returns JSON-RPC -32601', async () => {
  const { responses } = await rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'no/such/method' }]);
  assert.equal(responses.find((m) => m.id === 2).error.code, -32601);
});

test('malformed input returns a parse error without killing the server', async () => {
  const child = spawn(process.execPath, [SERVER, '--as', 'claude', '--channel', 'test'], {
    env: { ...process.env, AGENT_BRIDGE_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.write('{ this is not json }\n');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' })}\n`);
  child.stdin.end();
  await new Promise((r) => child.on('close', r));

  const frames = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(frames[0].error.code, -32700, 'first frame should be a parse error');
  assert.ok(frames.some((f) => f.id === 7), 'server kept serving after the bad line');
});

test('notifications get no response', async () => {
  const { responses } = await rpc([
    INIT,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
  ]);
  assert.equal(responses.length, 2, 'only initialize and ping should answer');
});

test('two requests on one line are both answered', async () => {
  const { responses } = await rpc([INIT, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  assert.ok(responses.find((m) => m.id === 1));
  assert.ok(responses.find((m) => m.id === 2));
});

test('stdout carries only protocol frames; chatter goes to stderr', async () => {
  const { responses, stderr } = await rpc([INIT]);
  assert.equal(responses.length, 1, 'no stray output on stdout');
  assert.match(stderr, /serving as "claude"/);
});

test('an invalid --as role exits non-zero with a clear message', async () => {
  const { code, stderr } = await rpc([INIT], { as: 'bogus' });
  assert.equal(code, 2);
  assert.match(stderr, /--as must be one of claude\|cursor/);
});

test('only peers on the same channel see each other', async () => {
  await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_send', arguments: { text: 'channel A only' } },
  }], { as: 'claude', channel: 'alpha' });

  const { responses } = await rpc([INIT, {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'bridge_inbox', arguments: {} },
  }], { as: 'cursor', channel: 'beta' });
  assert.match(textOf(responses.find((m) => m.id === 2)), /No new messages/);
});
