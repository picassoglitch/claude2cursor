import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, cleanup } from './helpers.mjs';
import * as bridge from '../src/bridge.mjs';

const CH = 'test';
let dir;
beforeEach(() => { dir = sandbox(); });
afterEach(() => cleanup(dir));

test('send returns a message with an id, thread and timestamp', () => {
  const m = bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'hi' });
  assert.match(m.id, /^m_[0-9a-f]{8}$/);
  assert.match(m.thread, /^t_[0-9a-f]{8}$/);
  assert.equal(m.from, 'claude');
  assert.equal(m.to, 'cursor');
  assert.equal(m.type, 'message');
  assert.ok(!Number.isNaN(Date.parse(m.ts)));
});

test('send rejects empty or whitespace-only text', () => {
  for (const text of ['', '   ', '\n', null, undefined]) {
    assert.throws(() => bridge.send({ channel: CH, from: 'claude', text }), /text is required/);
  }
});

test('a message reaches the peer inbox exactly once', () => {
  bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'ping' });

  const first = bridge.inbox({ channel: CH, me: 'cursor' });
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].text, 'ping');

  const second = bridge.inbox({ channel: CH, me: 'cursor' });
  assert.equal(second.messages.length, 0, 'must not redeliver');
});

test('a sender never receives its own message', () => {
  bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'mine' });
  assert.equal(bridge.inbox({ channel: CH, me: 'claude' }).messages.length, 0);
});

test('to:"all" reaches the other side but still not the sender', () => {
  bridge.send({ channel: CH, from: 'claude', to: 'all', text: 'broadcast' });
  assert.equal(bridge.inbox({ channel: CH, me: 'cursor' }).messages.length, 1);
  assert.equal(bridge.inbox({ channel: CH, me: 'claude' }).messages.length, 0);
});

test('peek leaves messages unread', () => {
  bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'peek me' });
  assert.equal(bridge.inbox({ channel: CH, me: 'cursor', peek: true }).messages.length, 1);
  assert.equal(bridge.inbox({ channel: CH, me: 'cursor' }).messages.length, 1, 'peek must not consume');
});

test('limit defers the remainder instead of dropping it', () => {
  for (let i = 0; i < 5; i++) {
    bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: `m${i}` });
  }
  const first = bridge.inbox({ channel: CH, me: 'cursor', limit: 2 });
  assert.deepEqual(first.messages.map((m) => m.text), ['m0', 'm1']);
  assert.equal(first.remaining, 3);

  const rest = bridge.inbox({ channel: CH, me: 'cursor', limit: 10 });
  assert.deepEqual(rest.messages.map((m) => m.text), ['m2', 'm3', 'm4']);
  assert.equal(rest.remaining, 0);
});

// Regression: a thread-filtered poll used to jump the watermark to the end of
// the log, permanently swallowing unread messages in every other thread. This
// fired on each 300ms poll of a blocking bridge_ask.
test('a thread-filtered read does not consume other threads', () => {
  const kept = bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'in thread A' });

  const miss = bridge.inbox({ channel: CH, me: 'claude', thread: 't_unrelated' });
  assert.equal(miss.messages.length, 0);

  const after = bridge.inbox({ channel: CH, me: 'claude' });
  assert.equal(after.messages.length, 1, 'message in another thread must survive');
  assert.equal(after.messages[0].text, 'in thread A');
  assert.equal(after.messages[0].thread, kept.thread);
});

test('repeated thread-filtered polls still leave other threads intact', () => {
  bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'keep me' });
  for (let i = 0; i < 25; i++) {
    bridge.inbox({ channel: CH, me: 'claude', thread: 't_nope' });
  }
  assert.equal(bridge.inbox({ channel: CH, me: 'claude' }).messages.length, 1);
});

test('a thread-filtered read consumes only its own thread', () => {
  const a = bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'thread A' });
  bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'thread B' });

  const onlyA = bridge.inbox({ channel: CH, me: 'claude', thread: a.thread });
  assert.deepEqual(onlyA.messages.map((m) => m.text), ['thread A']);

  const remaining = bridge.inbox({ channel: CH, me: 'claude' });
  assert.deepEqual(remaining.messages.map((m) => m.text), ['thread B'], 'A consumed, B intact');
});

test('out-of-order reads fold back into the watermark', () => {
  const a = bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'A' });
  bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'B' });

  // Consume the later-listed thread first, forcing a non-contiguous cursor.
  bridge.inbox({ channel: CH, me: 'claude', thread: a.thread });
  bridge.inbox({ channel: CH, me: 'claude' });

  const state = bridge.getCursorState(CH, 'claude');
  assert.equal(state.seen, 2, 'watermark should have absorbed both');
  assert.deepEqual(state.extra, [], 'no stragglers left behind');
});

test('wait resolves as soon as a message lands', async () => {
  setTimeout(() => bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'late' }), 60);
  const got = await bridge.wait({ channel: CH, me: 'cursor', timeoutMs: 4000, pollMs: 20 });
  assert.equal(got.messages[0].text, 'late');
  assert.ok(!got.timedOut);
});

test('wait times out cleanly with nothing on the bus', async () => {
  const got = await bridge.wait({ channel: CH, me: 'cursor', timeoutMs: 120, pollMs: 20 });
  assert.equal(got.messages.length, 0);
  assert.equal(got.timedOut, true);
});

test('ask completes when the peer answers in-thread', async () => {
  setTimeout(() => {
    const q = bridge.inbox({ channel: CH, me: 'cursor' }).messages[0];
    bridge.send({ channel: CH, from: 'cursor', to: 'claude', thread: q.thread, type: 'answer', text: '42' });
  }, 60);

  const res = await bridge.ask({ channel: CH, from: 'claude', to: 'cursor', text: 'answer?', timeoutMs: 4000 });
  assert.equal(res.reply.text, '42');
  assert.equal(res.reply.thread, res.sent.thread);
  assert.equal(res.timedOut, false);
});

test('ask reports a timeout rather than hanging', async () => {
  const res = await bridge.ask({ channel: CH, from: 'claude', to: 'cursor', text: 'nobody home', timeoutMs: 120 });
  assert.equal(res.reply, null);
  assert.equal(res.timedOut, true);
});

test('an answer in the wrong thread does not satisfy ask', async () => {
  setTimeout(() => {
    bridge.send({ channel: CH, from: 'cursor', to: 'claude', text: 'unrelated chatter' });
  }, 40);
  const res = await bridge.ask({ channel: CH, from: 'claude', to: 'cursor', text: 'q', timeoutMs: 250 });
  assert.equal(res.reply, null, 'must not accept an off-thread reply');
  // ...and the unrelated message is still waiting afterwards.
  assert.equal(bridge.inbox({ channel: CH, me: 'claude' }).messages.length, 1);
});

test('peers records both sides and marks liveness', () => {
  bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'x' });
  bridge.inbox({ channel: CH, me: 'cursor' });
  const list = bridge.peers(CH);
  assert.deepEqual(list.map((p) => p.peer), ['claude', 'cursor']);
  for (const p of list) assert.ok(!Number.isNaN(Date.parse(p.lastSeen)));
});

test('a torn trailing line does not break the reader', () => {
  bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'good' });
  const log = path.join(bridge.channelDir(CH), 'messages.jsonl');
  fs.appendFileSync(log, '{"partial":true,');
  const all = bridge.readAll(CH);
  assert.equal(all.length, 1, 'the intact message survives a torn line');
  assert.equal(bridge.inbox({ channel: CH, me: 'cursor' }).messages.length, 1);
});

test('readAll is empty for a channel that was never written', () => {
  assert.deepEqual(bridge.readAll('never-used'), []);
});

// Regression: "." and ".." satisfied the sanitiser's charset, so `--channel ..`
// resolved to the bridge home itself and wrote messages.jsonl there.
test('channel names cannot escape the channels directory', () => {
  const channels = path.join(bridge.home(), 'channels');
  for (const name of ['..', '.', '../..', '../../etc', 'a/../../b', '...']) {
    const resolved = path.resolve(bridge.channelDir(name));
    assert.equal(path.dirname(resolved), channels, `"${name}" escaped to ${resolved}`);
  }
});

test('ordinary channel names survive sanitising intact', () => {
  assert.equal(path.basename(bridge.channelDir('my-project_v2.1')), 'my-project_v2.1');
});

test('resolveChannel honours explicit > env > default', () => {
  delete process.env.AGENT_BRIDGE_CHANNEL;
  assert.equal(bridge.resolveChannel(), 'default');
  process.env.AGENT_BRIDGE_CHANNEL = 'from-env';
  assert.equal(bridge.resolveChannel(), 'from-env');
  assert.equal(bridge.resolveChannel('explicit'), 'explicit');
  delete process.env.AGENT_BRIDGE_CHANNEL;
});

test('auto resolves to a stable per-directory channel', () => {
  const a = bridge.autoChannel(process.cwd());
  const b = bridge.autoChannel(process.cwd());
  assert.equal(a, b, 'must be deterministic');
  assert.match(a, /-[0-9a-f]{8}$/);
});

test('formatMessage renders sender, recipient, thread and type', () => {
  const m = bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'hello', type: 'question' });
  const out = bridge.formatMessage(m);
  assert.match(out, /claude -> cursor/);
  assert.match(out, /\(question\)/);
  assert.match(out, new RegExp(`\\{${m.thread}\\}`));
  assert.match(out, /hello/);
});

test('formatMessage indents multi-line bodies', () => {
  const m = bridge.send({ channel: CH, from: 'claude', to: 'cursor', text: 'line one\nline two' });
  assert.match(bridge.formatMessage(m), /\n {4}line two/);
});
