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
| **Screen capture** | N/A | `/capture` (virtual terminal buffer) |
| **System prompt** | Not configurable | Custom file injection (`--append-system-prompt`) |
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
  └── Claude Code (node-pty)
        ├── Discord MCP server
        └── Slack MCP server
```

The wrapper can restart Claude Code on command (`/new`, `/model`), forward CLI commands (`/compact`, `/clear`), and auto-respawn on crashes — all without losing the chat connection.

For Codex, the wrapper uses its structured app-server API instead of scraping a
terminal:

```
wrapper.ts (always-on)
  ├── Codex app-server JSON-RPC client
  │     ├── thread/start, turn/start, turn/steer
  │     ├── thread/compact/start, turn/interrupt, thread goals
  │     └── approval + request_user_input relay
  └── Codex app-server
        ├── Discord MCP server
        └── Slack MCP server
```

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

- **Node.js** >= 20
- At least one authenticated agent CLI:
  - **Claude Code** (`claude --version`, `claude login`)
  - **Codex** (`codex --version`, `codex login`)
- **Build tools** — `build-essential` / `python3` for `node-pty` compilation
- At least one of: **Discord Bot Token** or **Slack Bot Token**

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
cp .env.example .env   # edit with your tokens
npm run build
npm start
```

## Setup

### Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** → Enable all **Privileged Gateway Intents**:
   - Presence Intent
   - Server Members Intent
   - **Message Content Intent** (required)
3. Copy the bot token → paste into `.env` as `DISCORD_BOT_TOKEN`
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
7. Paste tokens into `.env` as `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`
8. Invite the bot to channels: `/invite @botname`

### Environment Variables

```env
# Agent backend
AGENT_PROVIDER=codex                  # claude (default) or codex
# CODEX_PATH=codex                    # Codex mode; defaults to "codex"
# CLAUDE_PATH=claude                  # Claude mode; defaults to "claude"

# Platform tokens (at least one required)
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Optional
# DEFAULT_MODEL=                      # empty = selected CLI default
# DEFAULT_REASONING_EFFORT=ultra       # Codex only; empty = Codex config
# DEFAULT_CWD=~/projects              # empty = current directory
MAX_TURNS=50                           # Claude Code only; 0 = unlimited
ALLOWED_CHANNEL_IDS=                   # comma-separated, empty = all
SLACK_ALLOWED_CHANNEL_IDS=
# DANGEROUSLY_SKIP_PERMISSIONS=true    # Claude flag / Codex never + full access
SYSTEM_PROMPT_PATH=data/system-prompt.txt
VERBOSE=false
```

## Commands

All commands work from both Discord and Slack.

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session/thread |
| `/clear` | Clear current context (Claude CLI command / fresh Codex thread) |
| `/compact [hint]` | Compress context. The optional focus hint is supported by Claude Code |
| `/model <name>` | Switch model. Claude supports `sonnet`/`opus`/`haiku` aliases; Codex accepts a full Codex model ID |
| `/effort [level]` | Show or change Codex reasoning effort. Supported levels are validated against the current model |
| `/cwd <path>` | Change the agent's working directory |
| `/capture [--all]` | Claude: capture the CLI screen. Codex: show app-server thread/turn status and recent events |
| `/esc` | Interrupt the active operation |
| `/raw <text>` | Claude: type into the CLI. Codex: submit the text as a turn |
| `/goal <condition>` | Set the agent goal; `/goal clear` clears it |
| `/help` | Show available commands |

Any other message is forwarded to the selected agent.

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
`developerInstructions` when a Codex thread starts.

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

**Session feels stuck**
- Send `/esc` to interrupt the active turn
- Send `/new` to start a fresh agent session
- Send `/clear` to reset the current context

## License

MIT
