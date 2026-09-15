# claude2cursor

**Two-way link between Claude Code and Cursor over a shared local message bus.**

Run one MCP server inside Claude Code and another inside Cursor. Both attach to
the same file-backed channel, so either agent can message, question, or directly
invoke the other — no daemon, no network, no credentials, zero dependencies.

## Install

```bash
npm install -g .
agent-bridge install
```

Restart both editors, approve `agent-bridge` in each, then:

```bash
agent-bridge doctor
```

`install` registers the bridge at user scope (every project). Use
`agent-bridge install --project` to scope it to the current repository instead.

## Tools exposed to each agent

| Tool | Behaviour |
| --- | --- |
| `bridge_send` | Fire-and-forget message to the peer |
| `bridge_inbox` | Read unread messages, mark them read; returns immediately |
| `bridge_wait` | Block until the peer sends something (default 60s, max 600s) |
| `bridge_ask` | Send a question and block until the peer answers in-thread |
| `bridge_history` | Recent transcript of both sides, regardless of read state |
| `bridge_peers` | Who is attached, and when each was last active |
| `ask_claude` / `ask_cursor` | Run the *other* agent headlessly for a one-shot answer |

The peer tool is named for whichever side you are not: Claude Code sees
`ask_cursor`, Cursor sees `ask_claude`.

`bridge_ask` needs the other agent actively watching the bridge. `ask_<peer>`
does not — it spawns a fresh headless agent, which therefore has no memory of
the session running on the other side. Use `bridge_peers` to tell which you want.

## CLI

Useful for driving or debugging the bridge by hand:

```bash
agent-bridge tail                       # live view of the transcript
agent-bridge send --as claude "hello"   # inject a message
agent-bridge inbox --as cursor --follow # watch one side's inbox
agent-bridge ask --as claude "question" # blocking round-trip
agent-bridge peers                      # who is attached
agent-bridge channel                    # resolved channel + storage path
agent-bridge clear                      # wipe this channel
```

To answer a `bridge_ask` that is still blocking, reply into its thread:

```bash
agent-bridge send --as cursor --thread <thread-id> --type answer "..."
```

## Channels

Both agents must share a channel to see each other. Resolution order:

```
--channel <name>  >  AGENT_BRIDGE_CHANNEL  >  "default"
```

The default is a single global channel, so the two agents meet regardless of
which project each has open. Use `--channel auto` (or `AGENT_BRIDGE_CHANNEL=auto`)
to derive the channel from the current git root instead, isolating the
conversation per repository.

## Configuration

Nothing is required — the bridge uses no credentials. Optional preferences can
be saved so they need not be exported into every shell:

```bash
agent-bridge config                                  # effective values + sources
agent-bridge config set channel auto
agent-bridge config set cursor-cmd /path/to/cursor-agent
```

Each setting resolves: environment variable → `~/.agent-bridge/config.json` →
auto-detection → built-in default.

| Setting | Environment variable | Purpose |
| --- | --- | --- |
| `channel` | `AGENT_BRIDGE_CHANNEL` | Channel to join |
| `claude-cmd` | `AGENT_BRIDGE_CLAUDE_CMD` | Path to the Claude Code CLI |
| `cursor-cmd` | `AGENT_BRIDGE_CURSOR_CMD` | Path to the Cursor CLI |
| `claude-args` | `AGENT_BRIDGE_CLAUDE_ARGS` | Extra args for headless Claude Code |
| `cursor-args` | `AGENT_BRIDGE_CURSOR_ARGS` | Extra args for headless Cursor |

Both CLIs are auto-detected: `PATH` first, then the usual install locations
(`~/.local/bin`, `/opt/homebrew/bin`, `~/.claude/local`, `~/.cursor/bin`,
`/Applications/Cursor.app/...`). This matters because an editor often hands a
spawned MCP server a narrower `PATH` than an interactive shell has.

## Storage

Under `~/.agent-bridge` (override with `AGENT_BRIDGE_HOME`):

```
channels/<channel>/messages.jsonl        append-only transcript, one JSON per line
channels/<channel>/cursors/<peer>.json   {"seen": <lines consumed>}
channels/<channel>/peers/<peer>.json     {"peer","role","lastSeen"}
```

Messages are appended as single small writes to an `O_APPEND` handle, which the
kernel keeps atomic at these line sizes. The transcript rotates at 5 MB.

Each side keeps its own read cursor, advanced only past messages actually handed
back — so a small `limit` defers the rest rather than dropping them.

## Requirements

Node.js >= 18. No runtime dependencies.

## License

MIT
