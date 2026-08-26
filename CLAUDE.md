# Compact Bot (`@serin511/compact-bot`)

Multi-platform chat bot (Discord + Slack) supporting both Claude Code and Codex.
Claude Code uses MCP Channels under a PTY wrapper. Codex uses `codex app-server`
JSON-RPC while reusing the same platform MCP tools. Both use existing CLI login
state; no API key is needed.

Published as `@serin511/compact-bot` on npm. CLI binary: `compact-bot`.

## Quick Start

```bash
npx @serin511/compact-bot init  # interactive setup → ~/.config/compact-bot/.env
npx @serin511/compact-bot       # run from anywhere (CWD .env overrides global)
npm install
npm run build      # compile TypeScript
npm run dev        # development (tsx → wrapper.ts)
npm start          # run compiled JS (wrapper.js)
npm run test:package  # clean pack/install plus actual node-pty spawn
```

## Test / Lint

```bash
npm test               # vitest run (all tests)
npm run test:watch     # vitest watch mode
npm run test:package   # clean tarball install, native PTY, nested MCP imports
npm run test:codex-smoke  # live Codex app-server turn (requires codex login)
npx tsc --noEmit       # type-check only
```

`test:codex-smoke` makes a real authenticated Codex request and is intentionally
not run in CI. Run `codex login` first. `CODEX_PATH`, `CODEX_SMOKE_MODEL`, and
`CODEX_SMOKE_EFFORT` can override the executable, model, and effort used by the
smoke test.

## Project Structure

```
src/
  cli.ts                    — CLI entry point (shebang, routes init/start subcommands)
  init.ts                   — Interactive setup: generates .env, copies custom files to ~/.config/compact-bot/
  paths.ts                  — Shared XDG path constants (CONFIG_HOME, DATA_DIR)
  wrapper.ts                — Main entrypoint: selects provider, owns IPC and agent lifecycle
  codex-app-server.ts       — Codex app-server JSON-RPC client, thread/turn lifecycle, approval/input relay
  mcp-server.ts             — MCP Channel server: Discord client, channel notifications, tool handlers
  slack-mcp-server.ts       — MCP Channel server: Slack client (Socket Mode + Web API), channel notifications, tool handlers
  ipc.ts                    — Unix domain socket IPC protocol (wrapper ↔ MCP servers + hook-runner)
  config.ts                 — Env-based configuration, compact prompt, allowed tools list, system prompt loader
  logger.ts                 — Structured, chalk-colored console logger
  message-router.ts         — Classifies Discord `/` and Slack `!` commands or chat
  messages.ts               — Customisable bot messages with JSON file overrides (data/messages.json)
  hook-runner.ts            — PreToolUse hook for AskUserQuestion (forwards tool_input → wrapper IPC)
  attachment-handler.ts     — Downloads Discord attachments to data/attachments/, builds prompt prefix
  slack-attachment-handler.ts — Downloads Slack attachments (Bearer auth) to data/attachments/, builds prompt prefix
  slack-events.ts           — Pure helpers for interpreting Slack Socket Mode events (e.g. processable subtypes)
tests/
  *.test.ts             — Unit tests (vitest)
```

## Architecture (MCP Channel Mode)

`AGENT_PROVIDER=claude` (the backward-compatible default):

```
wrapper.ts (npm start)
  ├─ IPC socket server (data/wrapper.sock) — multi-client
  ├─ Wrapper-owned Discord MCP process (conditional)
  │   ├─ Credentials injected over inherited fd 3
  │   └─ Discord Gateway, tools, commands, channel notifications
  ├─ Wrapper-owned Slack MCP process (conditional)
  │   ├─ Credentials injected over inherited fd 3
  │   └─ Socket Mode, Web API, tools, commands, channel notifications
  ├─ Private MCP relay (data/mcp.sock)
  ├─ Claude Code spawned via node-pty (interactive mode)
  │   ├─ Secretless Discord stdio proxy ─┐
  │   └─ Secretless Slack stdio proxy ───┴─ byte stream to wrapper-owned MCP
  └─ Restart on IPC signal (kill + respawn Claude Code) or PTY command forwarding
```

- **Multi-platform**: Discord and Slack run as separate MCP Channel plugins, conditionally enabled by token presence
- **Shared session**: Both platforms share the same Claude Code context — `/new` from either side restarts everything
- **MCP Channel**: Messages arrive as `<channel source="discord" ...>` or `<channel source="slack" ...>` tags
- **Tools**: Claude responds via MCP tool calls (reply, react, edit_message, etc.)
- **Hard restart**: `/new` kills and respawns Claude Code (fresh session)
- **PTY commands**: `/compact`, `/clear` forwarded to CLI via PTY write (no restart, MCP connection preserved)
- **Model/CWD change**: `/model`, `/cwd` trigger restart with new settings
- **Reasoning effort**: `/effort` is rejected in Claude mode
- **Screen capture**: `/capture` sends IPC request to wrapper → `@xterm/headless` virtual terminal reads PTY buffer → text returned as code block. Default captures only the visible viewport and sends a single message; `/capture --all` returns the full scrollback as multiple messages. `/capture` still runs while Claude Code is waiting for user input (bypasses the pending-input answer capture)
- **IPC**: Wrapper ↔ MCP servers communicate via shared Unix domain socket (JSON-line protocol, multi-client)
- **Credential boundary**: Claude's PTY environment and local MCP JSON contain
  no platform token or mutable wrapper IPC credential. The wrapper passes those
  values only to its own MCP child over an inherited file descriptor; Claude's
  stdio proxy carries MCP bytes only.
- **Auto-respawn**: If Claude Code exits unexpectedly, wrapper respawns after 2s delay
- **Single-instance guard** (`single-instance.ts`): each MCP server acquires a per-token lock (a listening Unix socket under `DATA_DIR`, keyed by a hash of `SLACK_APP_TOKEN` / `DISCORD_BOT_TOKEN`) before opening its realtime connection. If another live process already holds the token, the server stays up as an inert MCP server and periodically retries. It takes over Socket Mode / Gateway ownership when the prior owner exits. This prevents duplicate connections — a second `npx compact-bot`, or a Claude Code/VSCode session that has `slack-mcp-server.js` registered as an MCP server and auto-spawns another copy — from stealing messages (Slack round-robins events across all connected sockets for a token) or double-handling them (Discord).
- **Permission relay**: When `DANGEROUSLY_SKIP_PERMISSIONS=false`, MCP servers declare `claude/channel/permission` capability. Claude Code sends `permission_request` notifications instead of PTY prompts; MCP servers show interactive buttons (Discord: ButtonBuilder, Slack: Block Kit) and relay the verdict back via `permission` notification
- **AskUserQuestion relay (Claude Code 2.1.132+)**: Channels mode re-enabled the built-in `AskUserQuestion` tool, but it has no JSON-RPC notification — the Ink widget renders directly to the PTY. The wrapper attaches a `PreToolUse` hook (matcher `AskUserQuestion`) via `--settings`. The hook (`hook-runner.ts`) reads the tool event from stdin, forwards `tool_input` (questions, options, descriptions, previews) to the wrapper over `wrapper.sock`, and exits with `{}` (allow). The wrapper queues each question, sends a structured `input_request` to the connected MCP server, and translates the user's reply into PTY keystrokes (`Down × (n−1) + Enter` for option `n`; `Down × N + Enter` then text + `Enter` for the auto-added "Type something." custom answer). Claude Code sees a normal AskUserQuestion tool result. On multi-question calls Ink renders a final "Ready to submit your answers?" page after the last answer; the wrapper polls the virtual terminal for `Submit answers` / `Ready to submit` and auto-presses Enter only when the text appears (single-question calls have no confirmation page and receive no extra keystroke). The PreToolUse hook is co-installed at `dist/hook-runner.js`; the wrapper exposes `COMPACT_BOT_WRAPPER_SOCKET` to the spawned Claude Code process so the hook can reach the socket regardless of CWD.
- **Plan mode deny**: The wrapper also registers a `PreToolUse` hook for `EnterPlanMode`. The hook always returns a deny decision with a reason instructing Claude to use the `reply` MCP tool to share plans and ask for user approval directly, instead of entering the terminal-only plan mode. This ensures plan approval works through the existing channel UI without additional infrastructure.

## Architecture (Codex App Server Mode)

`AGENT_PROVIDER=codex`:

```
wrapper.ts
  ├─ IPC socket server (data/wrapper.sock)
  ├─ CodexAppServer (`codex app-server`, JSONL over stdio)
  │   ├─ thread/start + turn/start/turn/steer for inbound chat
  │   ├─ paginated thread/turns/list for structured transcript capture
  │   ├─ model/list for model-specific reasoning effort validation
  │   ├─ thread/compact/start, turn/interrupt, thread/goal/*
  │   └─ app-server approvals and request_user_input → existing channel UI
  ├─ Wrapper-owned Discord / Slack MCP processes (private fd 3 config)
  ├─ Private MCP relay (data/mcp.sock)
  └─ Codex app-server MCP children
      └─ Secretless stdio proxies → relay → wrapper-owned platform MCP
```

- Platform servers send normal chat messages to the wrapper over IPC because
  Codex does not consume Claude's `notifications/claude/channel` extension.
- The wrapper recreates the `<channel source="...">` envelope and submits it as
  app-server turn input.
- Codex starts secretless stdio proxies for the same platform MCP tools. The
  wrapper owns the real platform processes and their credentials; agent replies
  still go through `reply`, `react`, `edit_message`, and related tools.
- `/new`, `/clear`, model changes, and CWD changes stop the old app-server
  generation and the corresponding relay generation before starting a fresh
  runtime and thread. This prevents stale subscriptions, goals, proxies, and
  platform connections from surviving a session change.
- `/effort [level]` persists the current thread setting through
  `thread/settings/update`; subsequent turns use it without restarting the
  thread. The current model's `model/list` entry supplies the accepted values.
  Model changes reset an incompatible prior effort to the new model default.
- `/capture` renders metadata and paginated `thread/turns/list` items as a transcript
  (user/assistant messages, reasoning summaries, plans, command output, file
  changes, and MCP calls), merged with streamed progress from an active turn.
  The default returns the last 50 rendered lines to approximate a viewport;
  `--all` returns the newest 512 KiB of the current thread and marks older
  content as omitted. App-server does not expose a literal Codex TUI viewport.
- `system-prompt.txt` is read when the Codex runtime starts and sent as
  `developerInstructions`. Runtime-restarting commands (`/new`, `/clear`,
  `/model`, `/cwd`) reload the file; editing it does not mutate the current
  running thread.
- `DANGEROUSLY_SKIP_PERMISSIONS=true` maps to Codex `approvalPolicy=never` and
  `sandbox=danger-full-access`; otherwise Compact Bot forces
  `sandbox=workspace-write` and app-server approval requests are relayed to
  Discord/Slack.
- Codex mode rejects Discord/Slack credentials in a CWD `.env`. Store them in
  `CONFIG_HOME/.env` via `compact-bot init`, outside the agent workspace.
- Configure platform operator IDs in shared channels. Session-management
  commands and approval decisions are operator-only when the corresponding
  list is non-empty.

### Platform Differences

| Aspect | Discord | Slack |
|--------|---------|-------|
| Message limit | 2000 chars | 40000 chars (clients show "Show more" past ~4000) |
| Threading | message reference (reply_to) | thread_ts |
| Attachments | Public CDN | url_private + Bearer auth |
| Emoji | Unicode or `<:name:id>` | Name only (no colons) |
| Markdown | `**bold**` | `*bold*` (mrkdwn) |

## Commands

Discord uses the `/` prefix and Slack uses `!`; the names below are identical
on both platforms.

| Name | Description | Mechanism |
|------|-------------|-----------|
| `new` | New session | Claude/Codex: hard runtime restart and fresh session/thread |
| `clear` | Clear session | Claude: CLI `/clear`; Codex: hard runtime restart and fresh thread |
| `compact [hint]` | Compress context | Claude: PTY command; Codex: inject hint into history, then `thread/compact/start` |
| `model <name>` | Change model (sonnet/opus/haiku or full ID) | Restart with new model |
| `effort [level]` | Show/change Codex reasoning effort | Codex: IPC → `thread/settings/update`; Claude: unsupported |
| `cwd <path>` | Change working directory | Restart with new CWD |
| `capture [--all]` | Capture runtime transcript | Claude: viewport/full scrollback; Codex: last 50 lines/newest 512 KiB of paginated turn history |
| `esc` | Interrupt current operation | Claude: ESC key; Codex: `turn/interrupt` |
| `raw <text>` | Submit raw text | Claude: PTY input; Codex: submit/steer normal turn input |
| `goal <condition>` | Set/clear goal | Claude: PTY `/goal`; Codex: `thread/goal/*` |
| `help` | Show commands | Direct platform reply |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_PROVIDER` | No | `claude` (default) or `codex` |
| `DISCORD_BOT_TOKEN` | One of Discord/Slack | Discord bot token |
| `SLACK_BOT_TOKEN` | One of Discord/Slack | Slack Bot OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | With SLACK_BOT_TOKEN | Slack App-Level Token (`xapp-...`, Socket Mode) |
| `ALLOWED_CHANNEL_IDS` | No | Comma-separated Discord channel IDs |
| `DISCORD_OPERATOR_USER_IDS` | No | Discord users allowed to manage sessions and approve requests; empty trusts allowed channels |
| `SLACK_ALLOWED_CHANNEL_IDS` | No | Comma-separated Slack channel IDs |
| `SLACK_OPERATOR_USER_IDS` | No | Slack users allowed to manage sessions and approve requests; empty trusts allowed channels |
| `DEFAULT_MODEL` | No | Selected agent model (default: CLI default) |
| `DEFAULT_REASONING_EFFORT` | No | Codex reasoning effort (default: Codex config; must be supported by the model) |
| `DEFAULT_CWD` | No | Working directory (default: current directory) |
| `MAX_TURNS` | No | Claude Code max turns per session (default: 50; ignored by Codex) |
| `FETCH_MESSAGE_LIMIT` | No | Default message fetch count (default: 20) |
| `CLAUDE_PATH` | No | Path to Claude CLI (default: `claude` from PATH) |
| `CODEX_PATH` | No | Path to Codex CLI (default: `codex`; macOS app bundles are fallback) |
| `SYSTEM_PROMPT_PATH` | No | Custom prompt file; appended for Claude and sent as Codex `developerInstructions` |
| `DANGEROUSLY_SKIP_PERMISSIONS` | No | Claude flag; Codex `approvalPolicy=never` plus `danger-full-access` (default: false) |
| `VERBOSE` | No | Enable verbose logging (default: false) |

## Key Conventions

- ESM (`"type": "module"` in package.json), `.js` extensions in imports
- TypeScript strict mode, target ES2022, module Node16
- Config stored in `~/.config/compact-bot/` (XDG): `.env`, `messages.json`, `system-prompt.txt`
- Runtime data in `~/.config/compact-bot/data/`: sockets, MCP config, attachments
- Runtime directories are owner-only (`0700`); generated `.env` files and Unix
  sockets are `0600`.
- Env loading order: CWD `.env` (higher priority) → `~/.config/compact-bot/.env` (fills missing vars)
- All user-facing strings in Korean
- MCP server logs to stderr (stdout reserved for MCP protocol)
- At least one platform token (Discord or Slack) must be configured
- Keep both providers working: Claude-specific hooks/PTY behavior must remain
  behind `AGENT_PROVIDER=claude`; Codex-specific app-server behavior belongs in
  `codex-app-server.ts`.

## Discord / Slack Parity Rule

**Every user-facing feature, command, tool, bug fix, or behavior change must be applied to _both_ `src/mcp-server.ts` (Discord) and `src/slack-mcp-server.ts` (Slack) in the same commit.** Do not ship a change to one side only — platform differences belong in the "Platform Differences" table above, not in feature availability.

When touching one MCP server, always grep the other (`grep -n "<symbol>" src/slack-mcp-server.ts`) and port the change over, adapting only for platform-specific APIs (Discord.js vs Slack Web/Socket, Unicode vs mrkdwn, message length caps, etc.). If a feature genuinely cannot be supported on one side, call that out explicitly in the PR description.
