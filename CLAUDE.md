# Claude Discord Bot

Discord bot using Claude Code as an MCP Channel plugin.
Claude Code runs as the main process; our code is an MCP server bridging Discord.
Uses Claude Max subscription auth — no API key needed.

## Quick Start

```bash
npm install
npm run build      # compile TypeScript
npm run dev        # development (tsx → wrapper.ts)
npm start          # run compiled JS (wrapper.js)
```

Legacy mode (subprocess-per-message, without MCP):
```bash
npm run dev:legacy    # tsx src/index.ts
npm run start:legacy  # node dist/index.js
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
  wrapper.ts            — Main entrypoint: spawns Claude Code via node-pty, IPC server, lifecycle management
  mcp-server.ts         — MCP Channel server: Discord client, channel notifications, tool handlers
  ipc.ts                — Unix domain socket IPC protocol between wrapper and MCP server
  config.ts             — Env-based configuration, compact prompt, allowed tools list, system prompt loader
  logger.ts             — Structured, chalk-colored console logger
  message-router.ts     — Classifies messages as commands (/compact, /clear, /new, …) or chat
  messages.ts           — Customisable bot messages with JSON file overrides (data/messages.json)
  attachment-handler.ts — Downloads Discord attachments to data/attachments/, builds prompt prefix

  # Legacy (subprocess-per-message mode)
  index.ts              — Legacy entrypoint
  bot.ts                — Legacy message/reaction handler
  claude-cli.ts         — Legacy CLI subprocess spawner
  discord-sender.ts     — Legacy message delivery
  session-manager.ts    — Legacy session CRUD with JSON persistence
  compact.ts            — Legacy compact implementation
  process-tracker.ts    — Legacy cancel/retry tracking
tests/
  *.test.ts             — Unit tests (vitest)
```

## Architecture (MCP Channel Mode)

```
wrapper.ts (npm start)
  ├─ IPC socket server (data/wrapper.sock)
  ├─ Claude Code spawned via node-pty (interactive mode)
  │   └─ MCP server (spawned by Claude Code as subprocess)
  │       ├─ Discord.js client (Gateway connection)
  │       ├─ MCP tools: reply, react, edit_message, fetch_messages, download_attachment
  │       ├─ Command routing: /new, /clear, /compact, /model, /cwd, /help
  │       └─ Channel notifications (chat messages → Claude)
  └─ Restart on IPC signal (kill + respawn Claude Code) or PTY command forwarding
```

- **MCP Channel**: Discord messages arrive as `<channel source="discord" ...>` tags in Claude's context
- **Tools**: Claude responds via MCP tool calls (reply, react, edit_message, etc.)
- **Hard restart**: `/new` kills and respawns Claude Code (fresh session)
- **PTY commands**: `/compact`, `/clear` forwarded to CLI via PTY write (no restart, MCP connection preserved)
- **Model/CWD change**: `/model`, `/cwd` trigger restart with new settings
- **IPC**: Wrapper ↔ MCP server communicate via Unix domain socket (JSON-line protocol)
- **Auto-respawn**: If Claude Code exits unexpectedly, wrapper respawns after 2s delay

## Commands

| Command | Description | Mechanism |
|---------|-------------|-----------|
| `/new` | New session | Hard restart (no resume) |
| `/clear` | Clear session | CLI `/clear` via PTY |
| `/compact [hint]` | Compress context | CLI `/compact` via PTY |
| `/model <name>` | Change model | Restart with new `--model` flag |
| `/cwd <path>` | Change working directory | Restart with new CWD |
| `/help` | Show commands | Direct Discord reply |

## Key Conventions

- ESM (`"type": "module"` in package.json), `.js` extensions in imports
- TypeScript strict mode, target ES2022, module Node16
- Environment variables loaded via `dotenv/config` in `config.ts` (wrapper) and via MCP config env (MCP server)
- All user-facing strings in Korean
- MCP server logs to stderr (stdout reserved for MCP protocol)
