# Compact Bot

A self-hosted chat bridge that connects **Discord** and **Slack** to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) via MCP Channel plugins. Runs on your Claude Max subscription — no API key required.

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

Compact Bot solves this by inverting the relationship — a **wrapper** owns and controls the Claude Code process:

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

## Features

- **Multi-platform** — Discord and Slack run as independent MCP servers, conditionally enabled by token
- **Shared session** — Both platforms share the same Claude Code context
- **Attachments** — Upload images/files; Claude downloads them via `download_attachment` tool
- **Reply context** — Discord message references and Slack threads are preserved
- **MCP tools** — `reply`, `react`, `edit_message`, `fetch_messages`, `download_attachment`
- **Customizable messages** — Override any bot message via `data/messages.json`
- **Custom system prompt** — Append instructions via `SYSTEM_PROMPT_PATH`

## Prerequisites

- **Node.js** >= 20
- **Claude Code CLI** installed and authenticated (`claude --version`)
- **Claude Max subscription** (logged in via `claude login`)
- **Build tools** — `build-essential` / `python3` for `node-pty` compilation
- At least one of: **Discord Bot Token** or **Slack Bot Token**

## Quick Start

### Via npx (recommended)

```bash
# Create a project directory with your .env file
mkdir my-bot && cd my-bot
cp .env.example .env   # edit with your tokens
npx @serin511/compact-bot
```

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
# Platform tokens (at least one required)
DISCORD_BOT_TOKEN=
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...

# Optional
DEFAULT_MODEL=claude-sonnet-4-6       # claude-opus-4-6, claude-haiku-4-5-20251001
DEFAULT_CWD=~/projects
MAX_TURNS=50                           # 0 = unlimited
ALLOWED_CHANNEL_IDS=                   # comma-separated, empty = all
SLACK_ALLOWED_CHANNEL_IDS=
CLAUDE_PATH=~/.local/bin/claude
SYSTEM_PROMPT_PATH=data/system-prompt.txt
VERBOSE=false
```

## Commands

All commands work from both Discord and Slack.

| Command | Description |
|---------|-------------|
| `/new` | Start a fresh session (kills and respawns Claude Code) |
| `/clear` | Clear current context (forwarded to CLI) |
| `/compact [hint]` | Compress context with optional focus hint |
| `/model <name>` | Switch model — `sonnet`, `opus`, `haiku`, or full model ID |
| `/cwd <path>` | Change Claude Code's working directory |
| `/capture` | Capture the current CLI screen as a code block |
| `/help` | Show available commands |

Any other message is forwarded to Claude as a channel notification.

## Running in Production

Claude Code requires an interactive PTY, so use `tmux` or `screen`:

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

The content is injected via `--append-system-prompt` when Claude Code starts.

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

**node-pty build fails**
```bash
sudo apt install build-essential python3
npm rebuild node-pty
```

**Session feels stuck**
- Send `/new` to hard-restart Claude Code
- Send `/clear` to reset context without restarting

## License

MIT
