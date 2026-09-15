#!/usr/bin/env node
/**
 * agent-bridge CLI — inspect and drive the Claude Code <-> Cursor bridge by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as bridge from './bridge.mjs';
import { SETTINGS, loadConfig, saveConfig, setting, configPath, resolveBinary } from './config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(HERE, 'mcp.mjs');

const USAGE = `agent-bridge — two-way link between Claude Code and Cursor

  install [--project [dir]] [--channel <name>]
                               register the bridge with both editors
                               (default: user scope, every project)
  uninstall [--project [dir]]  remove that registration
  doctor                       check the install, the CLIs, and who is attached
  config                       show effective settings and where each comes from
  config set <key> <value>     save an optional preference
  config unset <key>           drop it again

  tail [--limit <n>]           live view of the whole transcript
  send --as <me> [--to <who>] [--thread <id>] [--type <t>] <text>
                               --thread answers a bridge_ask that is still blocking
  inbox --as <me> [--peek] [--follow]
  ask --as <me> <text> [--timeout <s>]
  peers                        who is attached to this channel
  channel                      the resolved channel and its storage path
  clear                        wipe this channel's transcript

  mcp --as claude|cursor       run the MCP stdio server (editors launch this)

Channel: --channel <name> > AGENT_BRIDGE_CHANNEL > "default".
Use --channel auto for a separate conversation per git repository.
`;

function parseArgs(argv) {
  const flags = {}; const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--peek' || a === '--follow' || a === '--abs') flags[a.slice(2)] = true;
    else if (a === '--project') {
      const next = argv[i + 1];
      flags.project = next && !next.startsWith('--') ? argv[++i] : true;
    } else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

const { flags, rest } = parseArgs(process.argv.slice(2));
const cmd = rest.shift();
const channel = bridge.resolveChannel(flags.channel || (flags.project ? 'auto' : null));

function requireRole(v) {
  if (!bridge.ROLES.includes(v)) {
    console.error(`--as must be one of ${bridge.ROLES.join('|')}`);
    process.exit(2);
  }
  return v;
}
const other = (me) => (me === 'claude' ? 'cursor' : 'claude');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const onPath = (bin) => (process.env.PATH || '').split(path.delimiter)
  .some((d) => { try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return true; } catch { return false; } });

/**
 * Prefer the globally installed binary so generated config survives this
 * checkout moving or being deleted; fall back to an absolute path to the
 * server if the package was never linked onto PATH.
 */
function mcpEntry(role) {
  const global = onPath('agent-bridge') && !flags.abs;
  return {
    command: global ? 'agent-bridge' : process.execPath,
    args: global ? ['mcp', '--as', role] : [MCP, '--as', role],
    env: { AGENT_BRIDGE_CHANNEL: channel },
  };
}

function editJson(file, mutate) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new or empty */ }
  const next = mutate(cfg);
  if (next === null) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return true;
}

const addServer = (role) => (cfg) => ({
  ...cfg,
  mcpServers: { ...(cfg.mcpServers || {}), 'agent-bridge': mcpEntry(role) },
});
const dropServer = (cfg) => {
  if (!cfg.mcpServers?.['agent-bridge']) return null;
  const { 'agent-bridge': _gone, ...keep } = cfg.mcpServers;
  return { ...cfg, mcpServers: keep };
};

/** Claude Code owns its own MCP registry, so go through its CLI rather than editing its config. */
function claudeMcp(args, label) {
  if (!onPath('claude')) {
    console.log(`  -- claude CLI not on PATH; run this yourself:\n     claude mcp ${args.join(' ')}`);
    return;
  }
  try {
    execFileSync('claude', ['mcp', ...args], { stdio: 'pipe' });
    console.log(`  ok ${label}`);
  } catch (e) {
    const msg = (e.stderr || e.stdout || '').toString().trim();
    console.log(`  -- ${label} failed: ${msg.split('\n')[0] || e.message}`);
  }
}

const cursorGlobalConfig = path.join(os.homedir(), '.cursor', 'mcp.json');

async function main() {
  switch (cmd) {
    case 'install': {
      const entry = mcpEntry('claude');
      if (flags.project) {
        const dir = path.resolve(flags.project === true ? process.cwd() : flags.project);
        editJson(path.join(dir, '.mcp.json'), addServer('claude'));
        editJson(path.join(dir, '.cursor', 'mcp.json'), addServer('cursor'));
        console.log(`installed for project ${dir}`);
      } else {
        editJson(cursorGlobalConfig, addServer('cursor'));
        console.log(`  ok Cursor  -> ${cursorGlobalConfig}`);
        // -e is variadic, so the server name has to precede it or it gets eaten.
        claudeMcp(['add', '--scope', 'user', 'agent-bridge',
          '-e', `AGENT_BRIDGE_CHANNEL=${channel}`,
          '--', entry.command, ...entry.args], 'Claude Code -> user scope');
      }
      if (entry.command !== 'agent-bridge') {
        console.log(`\n  note: "agent-bridge" is not on PATH, so the config points at\n`
          + `        ${MCP}\n        Run "npm install -g ." in this project to make it portable.`);
      }
      console.log(`\nchannel: ${channel}`);
      console.log('Restart Claude Code and Cursor, approve "agent-bridge" in each, then: agent-bridge doctor');
      break;
    }
    case 'uninstall': {
      if (flags.project) {
        const dir = path.resolve(flags.project === true ? process.cwd() : flags.project);
        for (const f of [path.join(dir, '.mcp.json'), path.join(dir, '.cursor', 'mcp.json')]) {
          console.log(editJson(f, dropServer) ? `  removed from ${f}` : `  -- not present in ${f}`);
        }
      } else {
        console.log(editJson(cursorGlobalConfig, dropServer)
          ? `  removed from ${cursorGlobalConfig}` : `  -- not present in ${cursorGlobalConfig}`);
        claudeMcp(['remove', 'agent-bridge', '--scope', 'user'], 'Claude Code <- user scope');
      }
      break;
    }
    case 'config': {
      const [action, key, ...value] = rest;
      if (!action) {
        console.log(`config file: ${configPath()}\n`);
        for (const [k, spec] of Object.entries(SETTINGS)) {
          const { value: v, source } = setting(k);
          console.log(`  ${k.padEnd(12)} ${String(v ?? '(auto)').padEnd(24)} ${source}`);
          console.log(`  ${''.padEnd(12)} ${spec.describe}`);
        }
        console.log('\nNothing here is required — the bridge needs no credentials.');
        break;
      }
      if (!SETTINGS[key]) {
        console.error(`unknown setting "${key}" (try: ${Object.keys(SETTINGS).join(', ')})`);
        process.exit(2);
      }
      const cfg = loadConfig();
      if (action === 'set') {
        cfg[key] = value.join(' ');
        saveConfig(cfg);
        console.log(`${key} = ${cfg[key]}`);
      } else if (action === 'unset') {
        delete cfg[key];
        saveConfig(cfg);
        console.log(`${key} unset`);
      } else {
        console.error('usage: agent-bridge config [set|unset] <key> [value]');
        process.exit(2);
      }
      break;
    }
    case 'mcp': {
      spawn(process.execPath, [MCP, '--as', requireRole(flags.as), '--channel', channel],
        { stdio: 'inherit' }).on('exit', (c) => process.exit(c ?? 0));
      break;
    }
    case 'send': {
      const me = requireRole(flags.as);
      const msg = bridge.send({
        channel, from: me, to: flags.to || other(me), text: rest.join(' '),
        thread: flags.thread, replyTo: flags.thread, type: flags.type,
      });
      console.log(`sent ${msg.id} to ${msg.to} (thread ${msg.thread})`);
      break;
    }
    case 'inbox': {
      const me = requireRole(flags.as);
      do {
        const got = bridge.inbox({ channel, me, peek: !!flags.peek, limit: Number(flags.limit) || 20 });
        got.messages.forEach((m) => console.log(bridge.formatMessage(m)));
        if (flags.follow) await sleep(500);
      } while (flags.follow);
      break;
    }
    case 'ask': {
      const me = requireRole(flags.as);
      const res = await bridge.ask({
        channel, from: me, to: other(me), text: rest.join(' '),
        timeoutMs: (Number(flags.timeout) || 120) * 1000,
      });
      console.log(res.reply ? bridge.formatMessage(res.reply) : `no reply (thread ${res.sent.thread})`);
      break;
    }
    case 'tail': {
      let seen = Math.max(0, bridge.readAll(channel).length - (Number(flags.limit) || 20));
      console.log(`# channel ${channel} — ctrl-c to stop`);
      for (;;) {
        const now = bridge.readAll(channel);
        now.slice(seen).forEach((m) => console.log(bridge.formatMessage(m)));
        seen = now.length;
        await sleep(400);
      }
    }
    case 'peers': {
      const list = bridge.peers(channel);
      console.log(`channel ${channel}`);
      if (!list.length) console.log('  nobody attached yet');
      list.forEach((p) => console.log(`  ${p.peer} — last seen ${p.lastSeen}`));
      break;
    }
    case 'channel':
      console.log(`channel: ${channel}\nstorage: ${bridge.channelDir(channel)}`);
      break;
    case 'doctor': {
      const check = (label, pass, hint) =>
        console.log(`  ${pass ? 'ok  ' : 'MISS'} ${label}${pass || !hint ? '' : ` — ${hint}`}`);
      console.log(`channel ${channel}\nstorage ${bridge.channelDir(channel)}\n`);
      check('agent-bridge on PATH', onPath('agent-bridge'), 'run: npm install -g .');
      let cursorCfg = {};
      try { cursorCfg = JSON.parse(fs.readFileSync(cursorGlobalConfig, 'utf8')); } catch { /* none */ }
      check(`Cursor registered (${cursorGlobalConfig})`, !!cursorCfg.mcpServers?.['agent-bridge'],
        'run: agent-bridge install');
      let claudeReg = false;
      if (onPath('claude')) {
        try { claudeReg = execFileSync('claude', ['mcp', 'list'], { stdio: 'pipe' }).toString().includes('agent-bridge'); }
        catch { /* older CLI */ }
      }
      check('Claude Code registered (user scope)', claudeReg, 'run: agent-bridge install');
      for (const kind of ['claude', 'cursor']) {
        const { command, source, usable } = resolveBinary(kind);
        check(`${kind} CLI (${usable ? `${command} — ${source}` : `${command}: ${source}`})`, usable,
          `optional; needed for ask_${kind}. Set with: agent-bridge config set ${kind}-cmd <path>`);
      }
      const list = bridge.peers(channel);
      console.log(`\nattached: ${list.map((p) => p.peer).join(', ') || 'nobody yet'}`);
      break;
    }
    case 'clear':
      fs.rmSync(bridge.channelDir(channel), { recursive: true, force: true });
      console.log(`cleared channel ${channel}`);
      break;
    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
