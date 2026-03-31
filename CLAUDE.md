# Compact Bot (`@serin511/compact-bot`)

Multi-platform chat bot (Discord + Slack) using Claude Code as MCP Channel plugins.
Claude Code runs as the main process; our code is MCP servers bridging each platform.
Uses Claude Pro or Max subscription auth (Max recommended for higher usage limits) — no API key needed.

Published as `@serin511/compact-bot` on npm. CLI binary: `compact-bot`.

## Quick Start

```bash
npx @serin511/compact-bot init  # interactive setup → ~/.config/compact-bot/.env
npx @serin511/compact-bot       # run from anywhere (CWD .env overrides global)
npm install
npm run build      # compile TypeScript
npm run dev        # development (tsx → wrapper.ts)
npm start          # run compiled JS (wrapper.js)
```

## Test / Lint

```bash
npm test               # vitest run (all tests)
npm run test:watch     # vitest watch mode
npx tsc --noEmit       # type-check only
```

## Project Structure

```
src/
  cli.ts                    — CLI entry point (shebang, routes init/start subcommands)
  init.ts                   — Interactive setup: generates .env, copies custom files to ~/.config/compact-bot/
  paths.ts                  — Shared XDG path constants (CONFIG_HOME, DATA_DIR)
  wrapper.ts                — Main entrypoint: spawns Claude Code via node-pty, IPC server, lifecycle management
  mcp-server.ts             — MCP Channel server: Discord client, channel notifications, tool handlers
  slack-mcp-server.ts       — MCP Channel server: Slack client (Socket Mode + Web API), channel notifications, tool handlers
  ipc.ts                    — Unix domain socket IPC protocol between wrapper and MCP servers
  config.ts                 — Env-based configuration, compact prompt, allowed tools list, system prompt loader
  logger.ts                 — Structured, chalk-colored console logger
  message-router.ts         — Classifies messages as commands (/compact, /clear, /new, …) or chat
  messages.ts               — Customisable bot messages with JSON file overrides (data/messages.json)
  attachment-handler.ts     — Downloads Discord attachments to data/attachments/, builds prompt prefix
  slack-attachment-handler.ts — Downloads Slack attachments (Bearer auth) to data/attachments/, builds prompt prefix
tests/
  *.test.ts             — Unit tests (vitest)
```

## Architecture (MCP Channel Mode)

```
wrapper.ts (npm start)
  ├─ IPC socket server (data/wrapper.sock) — multi-client
  ├─ Claude Code spawned via node-pty (interactive mode)
  │   ├─ Discord MCP server (conditional: DISCORD_BOT_TOKEN)
  │   │   ├─ Discord.js client (Gateway connection)
  │   │   ├─ MCP tools: reply, react, edit_message, fetch_messages, download_attachment
  │   │   ├─ Command routing: /new, /clear, /compact, /model, /cwd, /capture, /help
  │   │   └─ Channel notifications (source="discord")
  │   └─ Slack MCP server (conditional: SLACK_BOT_TOKEN)
  │       ├─ Slack Socket Mode client (WebSocket connection)
  │       ├─ Slack Web API client (chat, reactions, files, etc.)
  │       ├─ MCP tools: reply, react, edit_message, fetch_messages, download_attachment
  │       ├─ Command routing: /new, /clear, /compact, /model, /cwd, /capture, /help
  │       └─ Channel notifications (source="slack")
  └─ Restart on IPC signal (kill + respawn Claude Code) or PTY command forwarding
```

- **Multi-platform**: Discord and Slack run as separate MCP Channel plugins, conditionally enabled by token presence
- **Shared session**: Both platforms share the same Claude Code context — `/new` from either side restarts everything
- **MCP Channel**: Messages arrive as `<channel source="discord" ...>` or `<channel source="slack" ...>` tags
- **Tools**: Claude responds via MCP tool calls (reply, react, edit_message, etc.)
- **Hard restart**: `/new` kills and respawns Claude Code (fresh session)
- **PTY commands**: `/compact`, `/clear` forwarded to CLI via PTY write (no restart, MCP connection preserved)
- **Model/CWD change**: `/model`, `/cwd` trigger restart with new settings
- **Screen capture**: `/capture` sends IPC request to wrapper → `@xterm/headless` virtual terminal reads PTY buffer → text returned as code block
- **IPC**: Wrapper ↔ MCP servers communicate via shared Unix domain socket (JSON-line protocol, multi-client)
- **Auto-respawn**: If Claude Code exits unexpectedly, wrapper respawns after 2s delay
- **Permission relay**: When `DANGEROUSLY_SKIP_PERMISSIONS=false`, MCP servers declare `claude/channel/permission` capability. Claude Code sends `permission_request` notifications instead of PTY prompts; MCP servers show interactive buttons (Discord: ButtonBuilder, Slack: Block Kit) and relay the verdict back via `permission` notification

### Platform Differences

| Aspect | Discord | Slack |
|--------|---------|-------|
| Message limit | 2000 chars | 4000 chars |
| Threading | message reference (reply_to) | thread_ts |
| Attachments | Public CDN | url_private + Bearer auth |
| Emoji | Unicode or `<:name:id>` | Name only (no colons) |
| Markdown | `**bold**` | `*bold*` (mrkdwn) |

## Commands

| Command | Description | Mechanism |
|---------|-------------|-----------|
| `/new` | New session | Hard restart (no resume) |
| `/clear` | Clear session | CLI `/clear` via PTY |
| `/compact [hint]` | Compress context | CLI `/compact` via PTY |
| `/model <name>` | Change model (sonnet/opus/haiku or full ID) | Restart with new `--model` flag |
| `/cwd <path>` | Change working directory | Restart with new CWD |
| `/capture` | Capture CLI screen | IPC request → code block reply |
| `/help` | Show commands | Direct Discord reply |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | One of Discord/Slack | Discord bot token |
| `SLACK_BOT_TOKEN` | One of Discord/Slack | Slack Bot OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | With SLACK_BOT_TOKEN | Slack App-Level Token (`xapp-...`, Socket Mode) |
| `ALLOWED_CHANNEL_IDS` | No | Comma-separated Discord channel IDs |
| `SLACK_ALLOWED_CHANNEL_IDS` | No | Comma-separated Slack channel IDs |
| `DEFAULT_MODEL` | No | Claude model (default: CLI default) |
| `DEFAULT_CWD` | No | Working directory (default: current directory) |
| `MAX_TURNS` | No | Max turns per session (default: 50) |
| `FETCH_MESSAGE_LIMIT` | No | Default message fetch count (default: 20) |
| `CLAUDE_PATH` | No | Path to Claude CLI (default: `claude` from PATH) |
| `DANGEROUSLY_SKIP_PERMISSIONS` | No | Pass `--dangerously-skip-permissions` to CLI (default: false) |
| `VERBOSE` | No | Enable verbose logging (default: false) |

## Key Conventions

- ESM (`"type": "module"` in package.json), `.js` extensions in imports
- TypeScript strict mode, target ES2022, module Node16
- Config stored in `~/.config/compact-bot/` (XDG): `.env`, `messages.json`, `system-prompt.txt`
- Runtime data in `~/.config/compact-bot/data/`: sockets, MCP config, attachments
- Env loading order: CWD `.env` (higher priority) → `~/.config/compact-bot/.env` (fills missing vars)
- All user-facing strings in Korean
- MCP server logs to stderr (stdout reserved for MCP protocol)
- At least one platform token (Discord or Slack) must be configured
