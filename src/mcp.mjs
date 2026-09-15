#!/usr/bin/env node
/**
 * MCP stdio server for agent-bridge.
 *
 * Run one instance inside Claude Code (--as claude) and one inside Cursor
 * (--as cursor). Both attach to the same channel, so a tool call on one side
 * is visible to the other.
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout is
 * reserved for protocol traffic; anything human-readable goes to stderr.
 */
import { execFile } from 'node:child_process';
import * as bridge from './bridge.mjs';
import { resolveBinary, setting } from './config.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER = { name: 'agent-bridge', version: '1.0.0' };

function parseArgs(argv) {
  const out = { as: null, channel: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--as') out.as = argv[++i];
    else if (argv[i] === '--channel') out.channel = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const me = args.as || process.env.AGENT_BRIDGE_ROLE || 'claude';
if (!bridge.ROLES.includes(me)) {
  console.error(`agent-bridge: --as must be one of ${bridge.ROLES.join('|')} (got "${me}")`);
  process.exit(2);
}
const peer = me === 'claude' ? 'cursor' : 'claude';
const channel = bridge.resolveChannel(args.channel);
bridge.touchPeer(channel, me);
console.error(`agent-bridge: serving as "${me}" on channel "${channel}" (peer: ${peer})`);

/* ---------------------------------------------------------------- helpers */

const clampTimeout = (s, def, max) => Math.min(Math.max(Number(s) || def, 1), max) * 1000;

function renderMessages(result, emptyText) {
  if (!result.messages.length) return emptyText;
  const body = result.messages.map(bridge.formatMessage).join('\n');
  const more = result.remaining
    ? `\n\n(${result.remaining} more queued — call again to read them)`
    : '';
  return `${body}${more}`;
}

function runAgent(kind, prompt, timeoutMs, cwd) {
  const isClaude = kind === 'claude';
  const { command: cmd } = resolveBinary(kind);
  const extra = (setting(isClaude ? 'claude-args' : 'cursor-args').value || '')
    .split(' ').filter(Boolean);
  const argv = [...extra, '-p', prompt];
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: timeoutMs, cwd: cwd || process.cwd(), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          return resolve({
            isError: true,
            text: `Could not run "${cmd}". Install the ${isClaude ? 'Claude Code' : 'Cursor'} CLI, or run `
              + `"agent-bridge config set ${isClaude ? 'claude-cmd' : 'cursor-cmd'} /path/to/${cmd}".`,
          });
        }
        if (err && err.killed) {
          return resolve({ isError: true, text: `${cmd} timed out after ${timeoutMs / 1000}s.\n${stdout || ''}` });
        }
        if (err) {
          return resolve({ isError: true, text: `${cmd} exited ${err.code}:\n${stderr || stdout || err.message}` });
        }
        resolve({ isError: false, text: stdout.trim() || '(no output)' });
      });
  });
}

/* ------------------------------------------------------------------ tools */

const tools = [
  {
    name: 'bridge_send',
    description: `Send a message to ${peer} over the shared bridge. Fire-and-forget: it lands in `
      + `${peer}'s inbox and is read on their next bridge_inbox/bridge_wait call. Use bridge_ask instead `
      + `when you need an answer back.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body.' },
        to: { type: 'string', description: `Recipient: "${peer}" or "all". Default "${peer}".` },
        thread: { type: 'string', description: 'Thread id to continue an existing exchange.' },
        reply_to: { type: 'string', description: 'Thread id of the message being answered.' },
        type: { type: 'string', description: 'message | question | answer | note. Default "message".' },
      },
      required: ['text'],
    },
  },
  {
    name: 'bridge_inbox',
    description: 'Read unread messages addressed to you and mark them read. Returns immediately, '
      + 'even when there is nothing new.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 20).' },
        peek: { type: 'boolean', description: 'Read without marking as read.' },
        thread: { type: 'string', description: 'Only messages in this thread.' },
      },
    },
  },
  {
    name: 'bridge_wait',
    description: `Block until ${peer} sends something, or until the timeout expires. Use this when you `
      + 'have handed off work and are waiting on a response.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'Default 60, max 600.' },
        thread: { type: 'string', description: 'Only wake for this thread.' },
      },
    },
  },
  {
    name: 'bridge_ask',
    description: `Send a question to ${peer} and block until they reply in the same thread. This is the `
      + `main round-trip tool: it requires ${peer} to be actively watching the bridge. If it times out, `
      + `they were not listening — fall back to ask_${peer}.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The question.' },
        timeout_seconds: { type: 'number', description: 'Default 120, max 600.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'bridge_history',
    description: 'Show the recent transcript of both sides of the bridge, regardless of read state.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Most recent N messages (default 30).' } },
    },
  },
  {
    name: 'bridge_peers',
    description: 'List the agents attached to this channel and when each was last active. Check this '
      + 'before bridge_ask to see whether the other side is around.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: `ask_${peer}`,
    description: `Run ${peer === 'cursor' ? 'Cursor' : 'Claude Code'} headlessly with a one-shot prompt and `
      + 'return its answer. Unlike bridge_ask this needs nobody watching — it starts a fresh agent in this '
      + 'repository, so it has no memory of the ongoing session on the other side.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to run.' },
        timeout_seconds: { type: 'number', description: 'Default 180, max 900.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to this server\'s cwd.' },
      },
      required: ['prompt'],
    },
  },
];

async function callTool(name, a = {}) {
  switch (name) {
    case 'bridge_send': {
      const msg = bridge.send({
        channel, from: me, to: a.to || peer, text: a.text,
        thread: a.thread, replyTo: a.reply_to, type: a.type,
      });
      return { text: `Sent to ${msg.to}. Thread: ${msg.thread}` };
    }
    case 'bridge_inbox': {
      const got = bridge.inbox({
        channel, me, limit: a.limit ?? 20, peek: !!a.peek, thread: a.thread,
      });
      return { text: renderMessages(got, `No new messages from ${peer}.`) };
    }
    case 'bridge_wait': {
      const got = await bridge.wait({
        channel, me, timeoutMs: clampTimeout(a.timeout_seconds, 60, 600), thread: a.thread,
      });
      return { text: renderMessages(got, `Timed out — ${peer} sent nothing.`) };
    }
    case 'bridge_ask': {
      const res = await bridge.ask({
        channel, from: me, to: peer, text: a.text,
        timeoutMs: clampTimeout(a.timeout_seconds, 120, 600),
      });
      if (!res.reply) {
        return {
          text: `No reply from ${peer} within the timeout (thread ${res.sent.thread}). They may not be `
            + `watching the bridge — check bridge_peers, or use ask_${peer} for a headless one-shot.`,
        };
      }
      return { text: bridge.formatMessage(res.reply) };
    }
    case 'bridge_history': {
      const all = bridge.readAll(channel);
      const recent = all.slice(-(Number(a.limit) || 30));
      return { text: recent.length ? recent.map(bridge.formatMessage).join('\n') : 'Bridge is empty.' };
    }
    case 'bridge_peers': {
      const list = bridge.peers(channel);
      const lines = list.map((p) => `${p.peer}${p.peer === me ? ' (you)' : ''} — last seen ${p.lastSeen}`);
      return { text: `Channel "${channel}"\n${lines.join('\n') || 'nobody attached yet'}` };
    }
    case `ask_${peer}`: {
      const res = await runAgent(peer, a.prompt, clampTimeout(a.timeout_seconds, 180, 900), a.cwd);
      // Keep the transcript honest about out-of-band round trips.
      bridge.send({
        channel, from: me, to: peer, type: 'note',
        text: `[headless ask_${peer}] ${String(a.prompt).slice(0, 200)}`,
      });
      return res;
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

/* ----------------------------------------------------------- JSON-RPC loop */

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const ok = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: `Two-way link between Claude Code and Cursor. You are "${me}"; the other side is `
          + `"${peer}". bridge_send/bridge_inbox for async notes, bridge_ask to block on an answer, `
          + `ask_${peer} to run the other agent headlessly.`,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools });
    case 'tools/call': {
      try {
        const res = await callTool(params?.name, params?.arguments || {});
        return ok(id, {
          content: [{ type: 'text', text: res.text }],
          ...(res.isError ? { isError: true } : {}),
        });
      } catch (err) {
        return ok(id, { content: [{ type: 'text', text: `agent-bridge error: ${err.message}` }], isError: true });
      }
    }
    default:
      if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
let inFlight = 0;
let stdinClosed = false;

/** Never exit with a tool call still running: the client is owed a response. */
function exitWhenIdle() {
  if (!stdinClosed) return;
  if (inFlight > 0) return void setTimeout(exitWhenIdle, 50);
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); continue; }
    for (const one of Array.isArray(msg) ? msg : [msg]) {
      inFlight++;
      Promise.resolve(handle(one))
        .catch((e) => console.error('agent-bridge:', e))
        .finally(() => { inFlight--; exitWhenIdle(); });
    }
  }
});
process.stdin.on('end', () => { stdinClosed = true; exitWhenIdle(); });
