/**
 * agent-bridge core: a file-backed message bus shared by two coding agents
 * (Claude Code and Cursor) running on the same machine.
 *
 * Storage layout (default ~/.agent-bridge):
 *   channels/<channel>/messages.jsonl   append-only transcript, one JSON per line
 *   channels/<channel>/cursors/<peer>.json  {"seen": <lines consumed>}
 *   channels/<channel>/peers/<peer>.json    {"peer","role","lastSeen"}
 *
 * No daemon, no dependencies. Appends are single small writes to an O_APPEND
 * handle, which the kernel keeps atomic for the line sizes we deal with.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { home, setting } from './config.mjs';

export { home };

export const ROLES = ['claude', 'cursor'];
export const ROTATE_BYTES = 5 * 1024 * 1024;

const sanitize = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120) || 'default';
const rid = (p) => `${p}_${crypto.randomBytes(4).toString('hex')}`;

export function projectRoot(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (out) return out;
  } catch { /* not a repo: fall through */ }
  return cwd;
}

/** Channel name derived from the current git root, for per-project isolation. */
export function autoChannel(cwd = process.cwd()) {
  const root = projectRoot(cwd);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 8);
  return sanitize(`${path.basename(root)}-${hash}`);
}

/**
 * The bridge is a global tool, not a per-repo one: by default both agents meet
 * on one shared channel no matter which project each has open. Pass "auto" (or
 * set AGENT_BRIDGE_CHANNEL=auto) to isolate the conversation per repository.
 * Precedence: explicit > AGENT_BRIDGE_CHANNEL > "default".
 */
export function resolveChannel(explicit) {
  const raw = explicit || setting('channel').value || 'default';
  return raw === 'auto' ? autoChannel() : sanitize(raw);
}

export function channelDir(channel) {
  const dir = path.join(home(), 'channels', sanitize(channel));
  fs.mkdirSync(path.join(dir, 'cursors'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'peers'), { recursive: true });
  return dir;
}

const logFile = (channel) => path.join(channelDir(channel), 'messages.jsonl');

function rotateIfNeeded(channel) {
  const file = logFile(channel);
  try {
    if (fs.statSync(file).size < ROTATE_BYTES) return;
  } catch { return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.renameSync(file, `${file}.${stamp}.bak`);
  const dir = channelDir(channel);
  for (const f of fs.readdirSync(path.join(dir, 'cursors'))) {
    fs.writeFileSync(path.join(dir, 'cursors', f), JSON.stringify({ seen: 0 }));
  }
}

export function touchPeer(channel, peer, role = peer) {
  const file = path.join(channelDir(channel), 'peers', `${sanitize(peer)}.json`);
  fs.writeFileSync(file, JSON.stringify({ peer, role, lastSeen: new Date().toISOString() }));
}

export function peers(channel) {
  const dir = path.join(channelDir(channel), 'peers');
  return fs.readdirSync(dir).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.peer.localeCompare(b.peer));
}

export function send({ channel, from, to = 'all', text, thread, replyTo, type = 'message', meta }) {
  if (!text || !String(text).trim()) throw new Error('text is required');
  rotateIfNeeded(channel);
  const msg = {
    id: rid('m'),
    ts: new Date().toISOString(),
    from,
    to,
    thread: thread || (replyTo ? replyTo : rid('t')),
    type,
    text: String(text),
    ...(replyTo ? { replyTo } : {}),
    ...(meta ? { meta } : {}),
  };
  fs.appendFileSync(logFile(channel), `${JSON.stringify(msg)}\n`);
  touchPeer(channel, from);
  return msg;
}

export function readAll(channel) {
  let raw;
  try { raw = fs.readFileSync(logFile(channel), 'utf8'); } catch { return []; }
  const out = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push({ ...JSON.parse(line), seq: i + 1 }); } catch { /* skip torn line */ }
  });
  return out;
}

const cursorFile = (channel, me) =>
  path.join(channelDir(channel), 'cursors', `${sanitize(me)}.json`);

export function getCursor(channel, me) {
  try { return JSON.parse(fs.readFileSync(cursorFile(channel, me), 'utf8')).seen || 0; }
  catch { return 0; }
}

export function setCursor(channel, me, seen) {
  fs.writeFileSync(cursorFile(channel, me), JSON.stringify({ seen }));
}

const addressedTo = (m, me) => m.from !== me && (m.to === me || m.to === 'all' || m.to === '*');

/**
 * Unread messages addressed to `me`. Advances the read cursor only past what it
 * actually hands back, so a small `limit` never drops messages on the floor.
 */
export function inbox({ channel, me, limit = 20, peek = false, thread }) {
  touchPeer(channel, me);
  const all = readAll(channel);
  const seen = getCursor(channel, me);
  let fresh = all.filter((m) => m.seq > seen && addressedTo(m, me));
  if (thread) fresh = fresh.filter((m) => m.thread === thread);
  const picked = fresh.slice(0, limit);
  if (!peek) {
    setCursor(channel, me, picked.length ? picked[picked.length - 1].seq : all.length);
  }
  return { messages: picked, remaining: Math.max(0, fresh.length - picked.length) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the bus until something addressed to `me` shows up, or we time out. */
export async function wait({ channel, me, timeoutMs = 60000, thread, pollMs = 300, limit = 20 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = inbox({ channel, me, limit, thread });
    if (got.messages.length) return got;
    if (Date.now() >= deadline) return { messages: [], remaining: 0, timedOut: true };
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Send a question and block on the bus until the peer answers in that thread. */
export async function ask({ channel, from, to, text, timeoutMs = 120000 }) {
  const sent = send({ channel, from, to, text, type: 'question' });
  const got = await wait({ channel, me: from, timeoutMs, thread: sent.thread });
  return { sent, reply: got.messages[0] || null, timedOut: !!got.timedOut };
}

export function formatMessage(m) {
  const when = new Date(m.ts).toLocaleTimeString();
  const tag = m.type && m.type !== 'message' ? ` (${m.type})` : '';
  return `[${when}] ${m.from} -> ${m.to}${tag} {${m.thread}}\n    ${m.text.replace(/\n/g, '\n    ')}`;
}
