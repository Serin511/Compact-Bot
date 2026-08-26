# Compact Bot

A self-hosted chat bridge that connects **Discord** and **Slack** to either
**Claude Code** or **OpenAI Codex**. Claude Code uses MCP Channels; Codex uses
the official `codex app-server` protocol while reusing the same Discord/Slack
MCP tools. Both backends use your existing CLI login, so no API key is required.

Choose the backend during `compact-bot init`, or set
`AGENT_PROVIDER=claude|codex`.

## Why not the official Discord plugin?

Claude Code ships with a [built-in Channels plugin](https://docs.anthropic.com/en/docs/claude-code/channels) — but CLI-native commands like `/compact` and `/clear` simply don't work through it. They need to be typed directly into the interactive terminal, and MCP servers have no way to do that.

This project started as a fix for that one problem: a wrapper that owns the Claude Code process and can forward PTY commands on your behalf. It then grew into a full-featured bridge with multi-platform support, session management, and more.

## Official Plugin vs Compact Bot

| | Official Plugin | This Project |
|---|---|---|
| **Platforms** | Discord only | Discord + Slack (simultaneous) |
| **Session** | Ephemeral (new context per invocation) | Persistent (always-on, shared across platforms) |
| **Session control** | None | `/new`, `/clear`, `/compact` |
| **Model switching** | Manual restart | `/model sonnet` (auto-restart) |
| **Working directory** | Fixed at launch | `/cwd /path` (auto-restart) |
| **Runtime capture** | N/A | `/capture` (Claude terminal / Codex transcript) |
| **System prompt** | Not configurable | Claude append / Codex developer instructions |
| **Message customization** | N/A | All bot messages overridable via JSON |
| **Auto-recovery** | N/A | Auto-respawn on unexpected exit |

### The core problem

The official plugin is spawned *by* Claude Code as a child MCP server. This means:

- **No PTY access** — CLI commands (`/compact`, `/clear`) can't be forwarded because there's no terminal to type into
- **No lifecycle control** — when Claude Code stops, everything stops, and there's no way to restart from chat
- **No state across restarts** — switching models or working directories requires manually killing and restarting

Compact Bot solves this by inverting the relationship — a **wrapper** owns and
controls the agent process. Claude Code keeps the original PTY architecture:

```
wrapper.ts (always-on)
  ├── Manages Claude Code lifecycle (spawn / kill / respawn)
  ├── Virtual terminal buffer (@xterm/headless) for screen capture
  ├── IPC socket for bidirectional control
  ├── Wrapper-owned Discord / Slack MCP processes
  │     └── Platform credentials injected over a private inherited FD
  ├── Private MCP byte-stream relay
  └── Claude Code (node-pty)
        ├── Secretless Discord stdio proxy ─┐
        └── Secretless Slack stdio proxy ───┴─ relay to wrapper-owned MCP
```

The wrapper can restart Claude Code on command (`/new`, `/model`), forward CLI commands (`/compact`, `/clear`), and auto-respawn on crashes — all without losing the chat connection.
Claude's local MCP JSON contains only the proxy executable, platform name, and
private socket path. Platform tokens and the wrapper-control credential are not
placed in Claude's PTY environment, command line, or local MCP configuration.

For Codex, the wrapper uses its structured app-server API instead of scraping a
terminal:

```
wrapper.ts (always-on)
  ├── Codex app-server JSON-RPC client
  │     ├── thread/start, turn/start, turn/steer
  │     ├── paginated thread/turns/list transcript capture
  │     ├── thread/compact/start, turn/interrupt, thread goals
  │     └── approval + request_user_input relay
  ├── Wrapper-owned Discord / Slack MCP processes (private fd 3 config)
  ├── Private MCP byte-stream relay
  └── Codex app-server
        ├── Secretless Discord stdio proxy ─┐
        └── Secretless Slack stdio proxy ───┴─ relay to wrapper-owned MCP
```

The Codex app-server environment is stripped of the same platform credentials,
and normal Codex sessions use the `workspace-write` sandbox. Platform tokens
must live in the protected Compact Bot configuration directory, not a
project-local `.env`, so model-spawned shell commands cannot read the bot
tokens or wrapper-control credential.

## Features

- **Multi-platform** — Discord and Slack run as independent MCP servers, conditionally enabled by token
- **Dual agent backend** — choose Claude Code or Codex without changing the chat platform setup
- **Shared session** — Both platforms share the same selected-agent context
- **Attachments** — Images/files sent with a message are downloaded automatically; their local paths are inlined into the prompt. The `download_attachment` tool fetches older attachments found via `fetch_messages`
- **Reply context** — Discord message references and Slack threads are preserved
- **MCP tools** — `reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`
- **Reasoning effort control** — Inspect or change Codex effort from chat with `/effort`
- **Customizable messages** — Override any bot message via `data/messages.json`
- **Custom system prompt** — Append instructions via `SYSTEM_PROMPT_PATH`

## Prerequisites

- **Node.js** >= 20.19
- At least one authenticated agent CLI:
  - **Claude Code** (`claude --version`, `claude login`)
  - **Codex** (`codex --version`, `codex login`)
- **Build tools** — `build-essential` / `python3` for `node-pty` compilation
- At least one of: **Discord Bot Token** or **Slack Bot Token**

Codex support uses its structured
[app-server protocol](https://learn.chatgpt.com/docs/app-server.md), including
experimental thread settings and goal endpoints. Keep the Codex CLI current if
those commands report an unsupported-method error.

## Quick Start

### Via npx (recommended)

```bash
npx @serin511/compact-bot init   # interactive setup → ~/.config/compact-bot/.env
npx @serin511/compact-bot        # run from anywhere
```

The setup wizard asks whether to use `claude` or `codex`. Existing
installations remain on Claude Code unless `AGENT_PROVIDER=codex` is added.

### From source

```bash
git clone https://github.com/Serin511/Compact-Bot.git
cd Compact-Bot
npm install
npm run init            # writes owner-only config outside the agent workspace
npm start
```

`npm install` runs the TypeScript build automatically. Maintainers can verify a
clean tarball install, its CLI, and an actual `node-pty` spawn with
`npm run test:package`.

Do not store Discord or Slack tokens in a project-local `.env` when using
Codex. Workspace files are readable by the agent, so Codex mode fails closed
when it finds platform credentials there. `compact-bot init` stores them in
`~/.config/compact-bot/.env` with owner-only permissions instead. Enabling
`DANGEROUSLY_SKIP_PERMISSIONS` deliberately removes the filesystem sandbox, so
only use it with fully trusted channels and prompts.

## Setup

### Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** → Enable the **Message Content Intent** privileged intent
3. Copy the bot token → enter it during `compact-bot init` as `DISCORD_BOT_TOKEN`
4. **OAuth2** → **URL Generator** → Scopes: `bot` → Permissions:
   - Send Messages / Send Messages in Threads
   - Read Message History
   - Attach Files / Add Reactions
5. Open the generated URL to invite the bot to your server

### Slack Bot

1. Go to [Slack API](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. **Socket Mode** → Enable → Create App-Level Token (`connections:write`) → copy `xapp-...` token
3. **OAuth & Permissions** → Add Bot Token Scopes:
   - `channels:history`, `channels:read`, `groups:history`, `groups:read`
   - `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`
   - `chat:write`, `files:read`, `files:write`, `reactions:write`, `users:read`
4. **Install to Workspace** → copy Bot User OAuth Token (`xoxb-...`)
5. **Event Subscriptions** → Enable → Subscribe to bot events:
   - `message.channels`, `message.groups`, `message.im`, `message.mpim`
6. **App Home** → Enable **Messages Tab** and allow messages from users
7. Enter both tokens during `compact-bot init` as `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
8. Invite the bot to channels: `/invite @botname`
9. Send `!help` in Slack to verify message delivery

### Environment Variables

```env
# Agent backend
AGENT_PROVIDER=codex                  # claude (default) or codex
# CODEX_PATH=codex                    # Codex mode; defaults to "codex"
# CLAUDE_PATH=claude                  # Claude mode; defaults to "claude"

# Platform tokens (at least one required)
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=                       # required together with SLACK_BOT_TOKEN

# Optional
# DEFAULT_MODEL=                      # empty = selected CLI default
# DEFAULT_REASONING_EFFORT=ultra       # Codex only; empty = Codex config
# DEFAULT_CWD=~/projects              # empty = current directory
MAX_TURNS=50                           # Claude Code only; 0 = unlimited
FETCH_MESSAGE_LIMIT=20                 # 0 = maximum; always capped at 500
ALLOWED_CHANNEL_IDS=                   # comma-separated, empty = all
DISCORD_OPERATOR_USER_IDS=             # comma-separated, empty = all users in allowed channels
SLACK_ALLOWED_CHANNEL_IDS=
SLACK_OPERATOR_USER_IDS=               # comma-separated, empty = all users in allowed channels
# DANGEROUSLY_SKIP_PERMISSIONS=true    # Claude flag / Codex never + full access
SYSTEM_PROMPT_PATH=data/system-prompt.txt
VERBOSE=false
```

Operator IDs control who may run state-changing or session-disclosing commands
and decide agent permission or approval requests. Leaving an operator list
empty preserves compatibility by trusting every user in the corresponding
allowed channels. Only leave it empty for private, trusted channels; otherwise
set explicit Discord or Slack user IDs.

## Commands

Discord commands use `/`; Slack commands use `!`. The command names and
behavior are otherwise identical.

| Discord | Slack | Description |
|---------|-------|-------------|
| `/new` | `!new` | Start a fresh session/thread |
| `/clear` | `!clear` | Clear current context (Claude CLI command / fresh Codex runtime and thread) |
| `/compact [hint]` | `!compact [hint]` | Compress context. Claude forwards the hint to its CLI; Codex injects it into thread history before compaction |
| `/model <name>` | `!model <name>` | Switch model. Claude supports `sonnet`/`opus`/`haiku` aliases; Codex accepts a full Codex model ID |
| `/effort [level]` | `!effort [level]` | Show or change the current Codex thread's reasoning effort. Supported levels are validated against the current model |
| `/cwd <path>` | `!cwd <path>` | Change the agent's working directory |
| `/capture [--all]` | `!capture [--all]` | Claude: capture the CLI screen/scrollback. Codex: capture the last 50 lines/current-thread transcript (newest 512 KiB) |
| `/esc` | `!esc` | Claude: send ESC. Codex: interrupt the active turn |
| `/raw <text>` | `!raw <text>` | Claude: type into the CLI. Codex: submit/steer a normal turn (not a Codex TUI slash command) |
| `/goal <condition>` | `!goal <condition>` | Set the agent goal; append `clear` to clear it |
| `/help` | `!help` | Show available commands |

Any other message is forwarded to the selected agent.

In Codex mode, `/capture` uses structured app-server thread items rather than a
literal terminal viewport. It includes available metadata, user/agent messages,
reasoning summaries, plans, command output, file changes, and MCP calls. The
active turn's streamed progress is merged in while it is running. The default
form returns the last 50 rendered transcript lines to approximate a CLI
viewport; `/capture --all` requests the current thread transcript and returns
its newest 512 KiB. Older content is marked as omitted when that safety limit
is reached.

`/effort` is Codex-only. A change applies to the next new turn without
restarting the thread; a turn already in progress keeps its original effort.
For example, `/effort ultra` works when the selected model advertises `ultra`
through Codex's model catalog. When switching models, an effort that the new
model does not advertise is reset to that model's default.

## Running in Production

Run Compact Bot under an always-on process manager. For source checkouts,
`tmux` or `screen` is sufficient (and keeps Claude Code's PTY attached):

```bash
tmux new-session -d -s claude-bot 'npm start'

# Attach to view logs
tmux attach -t claude-bot
```

## Message Customization

Create `data/messages.json` to override any bot message:

```json
{
  "newSession": "Starting fresh session...",
  "captureRequested": "Capturing screen..."
}
```

See [src/messages.ts](src/messages.ts) for all available keys and template variables.

## Custom System Prompt

Create a text file and point `SYSTEM_PROMPT_PATH` to it:

```bash
echo "Always respond in English. Be concise." > data/system-prompt.txt
```

The content is injected via `--append-system-prompt` for Claude Code and as
`developerInstructions` when a Codex runtime starts. Compact Bot reads the file
when it starts or restarts the agent runtime; editing it does not change an
already-running session. `/new`, `/clear`, `/model`, and `/cwd` restart the
Codex runtime and therefore load the current file contents.
Relative `SYSTEM_PROMPT_PATH` values are resolved from the directory where
Compact Bot is launched. `compact-bot init` avoids that ambiguity by copying
the selected file to the user configuration directory.

## Troubleshooting

**Bot doesn't respond to messages**
- Verify **Message Content Intent** is enabled (Discord Developer Portal → Bot)
- Check `ALLOWED_CHANNEL_IDS` — empty means all channels
- Ensure the bot has read/write permissions in the channel

**Claude CLI auth error**
```bash
claude auth status
claude login
```

**Codex CLI or app-server error**
```bash
codex --version
codex login
```

If `codex` is not on PATH, set `CODEX_PATH` to the executable. On macOS,
Compact Bot also checks the Codex binary bundled with the Codex and ChatGPT
desktop apps.

**node-pty build fails**
```bash
sudo apt install build-essential python3
npm rebuild node-pty
```

On macOS, Compact Bot's install hook locates the hoisted `node-pty` package and
repairs the bundled `spawn-helper` executable bit. A failed repair now stops
installation instead of being silently ignored.

**Session feels stuck**
- Discord: send `/esc`, `/new`, or `/clear`
- Slack: send `!esc`, `!new`, or `!clear`

## License

MIT
