/**
 * Wrapper: manages Claude Code lifecycle with node-pty.
 *
 * Spawns Claude Code in interactive mode with a pseudo-terminal,
 * registers MCP channel plugins (Discord and/or Slack, based on
 * configured tokens), and handles restart signals from any MCP
 * server for /new, /clear, /compact, /model, /cwd.
 *
 * Exports:
 *   None (side-effect: starts wrapper process).
 *
 * Example:
 *   >>> npx tsx src/wrapper.ts
 */

import pty from "node-pty";
import xtermHeadless from "@xterm/headless";
const { Terminal } = xtermHeadless;
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, loadSystemPrompt } from "./config.js";
import { log, setVerbose } from "./logger.js";
import { DATA_DIR } from "./paths.js";
import { detectUserPrompt } from "./prompt-detector.js";
import {
  createIpcServer,
  type McpToWrapper,
  type WrapperToMcp,
  type JsonLineSocket,
} from "./ipc.js";

setVerbose(config.verbose);

// ── paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** dist/ directory inside the installed package */
const DIST_DIR = __dirname.endsWith("src") ? join(__dirname, "..", "dist") : __dirname;

const SOCKET_PATH = join(DATA_DIR, "wrapper.sock");
const MCP_CONFIG_PATH = join(DATA_DIR, "mcp-config.json");

// ── state ─────────────────────────────────────────────────────────────

interface WrapperState {
  model: string;
  cwd: string;
}

const state: WrapperState = {
  model: config.defaultModel,
  cwd: config.defaultCwd,
};

const PTY_COLS = 200;
const PTY_ROWS = 50;

let claudeProcess: pty.IPty | null = null;
const mcpClients = new Set<JsonLineSocket>();
let expectedExit = false;
let spawnGrace = false;

// ── user input detection state ───────────────────────────────────────

let inputIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeInputRequestId: string | null = null;
const INPUT_IDLE_MS = 3000;
let inputRequestCounter = 0;

// ── virtual terminal (screen buffer) ─────────────────────────────────

let vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });

/**
 * Capture current screen content from the virtual terminal.
 *
 * Flushes pending writes first, then reads the active buffer
 * and returns non-empty lines as plain text.
 */
function captureScreen(): Promise<string> {
  return new Promise((resolve) => {
    // Flush pending async writes before reading the buffer
    vterm.write("", () => {
      const buf = vterm.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(false));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
      }
      // Uniform width: find rightmost content column, then slice all lines
      // to that width so right-aligned elements stay at the same column
      const maxLen = lines.reduce((m, l) => Math.max(m, l.trimEnd().length), 0);
      resolve(lines.map((l) => l.slice(0, maxLen)).join("\n"));
    });
  });
}

// ── user input detection ─────────────────────────────────────────────

/**
 * Generate a short unique request ID for input requests.
 */
function nextInputRequestId(): string {
  inputRequestCounter += 1;
  return `inp_${inputRequestCounter}_${Date.now().toString(36)}`;
}

/**
 * Check the terminal for a user prompt and broadcast to MCP servers.
 */
async function checkAndRelayUserPrompt(): Promise<void> {
  if (activeInputRequestId) return;
  if (mcpClients.size === 0) return;

  const screen = await captureScreen();
  const question = detectUserPrompt(screen);
  if (!question) return;

  const requestId = nextInputRequestId();
  activeInputRequestId = requestId;

  log.debug(`User prompt detected (id=${requestId}): ${question.slice(0, 100)}`);

  const msg: WrapperToMcp = {
    type: "input_request",
    request_id: requestId,
    question,
  };
  for (const client of mcpClients) {
    client.send(msg);
  }
}

/**
 * Reset the idle timer. Called on each PTY data event.
 */
function resetInputIdleTimer(): void {
  if (inputIdleTimer) clearTimeout(inputIdleTimer);
  inputIdleTimer = setTimeout(() => {
    checkAndRelayUserPrompt();
  }, INPUT_IDLE_MS);
}

/**
 * Handle a user's answer relayed from an MCP server.
 */
function handleInputResponse(requestId: string, answer: string): void {
  if (activeInputRequestId !== requestId) {
    log.debug(`Ignoring stale input response (expected=${activeInputRequestId}, got=${requestId})`);
    return;
  }

  log.debug(`Input response received (id=${requestId}): ${answer.slice(0, 100)}`);
  activeInputRequestId = null;

  // Write the answer to PTY — Claude Code reads from stdin
  writeToPty(`${answer}\r`);
}

// ── MCP config generation ─────────────────────────────────────────────

function generateMcpConfig(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const mcpServers: Record<string, unknown> = {};

  if (config.discordBotToken) {
    mcpServers["discord-bot"] = {
      command: "node",
      args: [join(DIST_DIR, "mcp-server.js")],
      env: {
        DISCORD_BOT_TOKEN: config.discordBotToken,
        WRAPPER_SOCKET: SOCKET_PATH,
        ALLOWED_CHANNEL_IDS: config.allowedChannelIds.join(","),
        FETCH_MESSAGE_LIMIT: String(config.fetchMessageLimit),
        VERBOSE: String(config.verbose),
      },
    };
  }

  if (config.slackBotToken) {
    mcpServers["slack-bot"] = {
      command: "node",
      args: [join(DIST_DIR, "slack-mcp-server.js")],
      env: {
        SLACK_BOT_TOKEN: config.slackBotToken,
        SLACK_APP_TOKEN: config.slackAppToken,
        WRAPPER_SOCKET: SOCKET_PATH,
        SLACK_ALLOWED_CHANNEL_IDS: config.slackAllowedChannelIds.join(","),
        FETCH_MESSAGE_LIMIT: String(config.fetchMessageLimit),
        VERBOSE: String(config.verbose),
      },
    };
  }

  writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2));
}

// ── Claude Code lifecycle ─────────────────────────────────────────────

function buildArgs(): string[] {
  const channels: string[] = [];
  if (config.discordBotToken) channels.push("server:discord-bot");
  if (config.slackBotToken) channels.push("server:slack-bot");

  const args = [
    ...(config.dangerouslySkipPermissions
      ? ["--dangerously-skip-permissions"]
      : []),
    "--mcp-config",
    MCP_CONFIG_PATH,
    "--dangerously-load-development-channels",
    ...channels,
    ...(state.model ? ["--model", state.model] : []),
  ];

  const systemPrompt = loadSystemPrompt();
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }

  if (config.maxTurns > 0) {
    args.push("--max-turns", String(config.maxTurns));
  }

  return args;
}

/**
 * Convert raw PTY output to readable text.
 *
 * Ink (Claude Code's terminal UI) uses cursor movement escape sequences
 * instead of literal spaces. Replace them with spaces before stripping
 * remaining ANSI codes.
 */
function ptyToText(data: string): string {
  return (
    data
      // Cursor movement → space
      .replace(/\x1b\[\d*C/g, " ")
      .replace(/\x1b\[\d*G/g, " ")
      // Cursor position → newline
      .replace(/\x1b\[\d+;\d+H/g, "\n")
      // Strip remaining ANSI sequences
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
      .replace(/\x1b\][^\x07]*\x07/g, "")
      // Collapse whitespace
      .replace(/ {2,}/g, " ")
      .trim()
  );
}

/**
 * Escape a string for safe inclusion in a shell command.
 *
 * Wraps the value in single quotes, escaping embedded single quotes.
 * Safe characters are passed through unquoted for readability.
 */
function shellEscape(arg: string): string {
  if (!/[^a-zA-Z0-9_\-./=:,@]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate that a file exists and is executable.
 *
 * Returns true if the file is a valid executable, false otherwise.
 */
function isExecutable(resolved: string): boolean {
  if (!existsSync(resolved)) return false;
  try {
    accessSync(resolved, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to resolve the Claude CLI to an absolute executable path.
 *
 * Returns the resolved path if found and executable, null otherwise.
 * Does NOT exit the process — callers should fall back to shell-based
 * spawning when this returns null.
 */
function resolveClaudePath(): string | null {
  const p = config.claudePath;

  // Explicit path (contains separator) — validate directly
  if (p.includes("/") || p.includes("\\")) {
    if (isExecutable(p)) return p;
    log.debug(`Explicit path not executable: ${p}`);
    return null;
  }

  // Command name — try to resolve via `which`
  try {
    const resolved = execSync(`which ${p}`, { encoding: "utf-8" }).trim();
    if (resolved && resolved.startsWith("/") && isExecutable(resolved)) {
      return resolved;
    }
  } catch { /* which failed — fall through */ }

  log.debug(`Could not resolve "${p}" to executable path, will try shell spawn`);
  return null;
}

const resolvedClaudePath = resolveClaudePath();

function spawnClaude(): void {
  const args = buildArgs();

  const channels =
    config.allowedChannelIds.length > 0
      ? config.allowedChannelIds.join(", ")
      : "all";
  log.ready("wrapper", state.model || "(CLI default)", state.cwd, channels);

  const ptyOpts = {
    name: "xterm-256color" as const,
    cols: PTY_COLS,
    rows: PTY_ROWS,
    cwd: state.cwd,
    env: process.env as Record<string, string>,
  };

  // Strategy 1: Spawn via user's shell (handles aliases, scripts, PATH)
  const shell = process.env.SHELL || "/bin/bash";
  const cmdLine = [config.claudePath, ...args].map(shellEscape).join(" ");
  try {
    claudeProcess = pty.spawn(shell, ["-ic", cmdLine], ptyOpts);
    log.debug(`Spawned Claude via ${shell}`);
  } catch (shellErr) {
    // Strategy 2: Direct spawn with resolved path
    if (resolvedClaudePath) {
      try {
        claudeProcess = pty.spawn(resolvedClaudePath, args, ptyOpts);
        log.debug(`Spawned Claude directly: ${resolvedClaudePath}`);
      } catch (directErr) {
        log.error(`Failed to spawn Claude CLI`, directErr);
      }
    }
    if (!claudeProcess) {
      const displayPath = resolvedClaudePath || config.claudePath;
      log.error(`Failed to spawn Claude CLI: ${displayPath}`, shellErr);
      console.error(
        `\n  Claude CLI 실행에 실패했습니다.\n` +
        `  경로: ${displayPath}\n` +
        `  인수: ${args.join(" ")}\n` +
        `  CWD:  ${state.cwd}\n\n` +
        `  가능한 원인:\n` +
        `  - claude CLI가 올바르게 설치되지 않았을 수 있습니다\n` +
        `  - shell alias 설정을 확인하세요 (SHELL=${shell})\n` +
        `  - CLAUDE_PATH 환경변수로 정확한 경로를 지정해보세요\n`,
      );
      process.exit(1);
    }
  }

  claudeProcess.onData((data) => {
    // Feed raw data to virtual terminal for accurate screen capture
    vterm.write(data);

    const clean = ptyToText(data);

    // Auto-confirm development channels prompt
    if (clean.includes("local development") || clean.includes("Enter to confirm")) {
      claudeProcess!.write("\r");
    }

    // Reset idle timer for user input detection
    resetInputIdleTimer();

    if (config.verbose && clean) {
      log.debug(clean);
    }
  });

  claudeProcess.onExit(({ exitCode }) => {
    log.debug(`Claude Code exited (code ${exitCode})`);
    claudeProcess = null;

    if (expectedExit || spawnGrace) {
      // Killed by restart() or transient startup failure — restart() handles respawn
      if (spawnGrace) {
        log.debug(`Claude Code exited during startup (code ${exitCode}), retrying...`);
        spawnGrace = false;
        setTimeout(() => {
          log.debug("Auto-respawning Claude Code...");
          spawnClaude();
        }, 2000);
      }
      expectedExit = false;
      return;
    }

    log.error("Claude Code exited unexpectedly", new Error(`exit ${exitCode}`));
    setTimeout(() => {
      log.debug("Auto-respawning Claude Code...");
      spawnClaude();
    }, 2000);
  });
}

function killClaude(): Promise<void> {
  return new Promise((resolve) => {
    if (!claudeProcess) {
      resolve();
      return;
    }
    expectedExit = true;
    const onExit = claudeProcess.onExit(() => {
      onExit.dispose();
      resolve();
    });
    claudeProcess.kill();
    // Force kill after 5 seconds
    setTimeout(() => {
      if (claudeProcess) {
        try {
          process.kill(claudeProcess.pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      resolve();
    }, 5000);
  });
}

async function restart(updates?: Partial<WrapperState>): Promise<void> {
  if (updates) Object.assign(state, updates);

  log.debug(
    `Restarting Claude Code (model=${state.model}, cwd=${state.cwd})`,
  );

  await killClaude();
  mcpClients.clear();

  // Reset input detection state
  if (inputIdleTimer) clearTimeout(inputIdleTimer);
  activeInputRequestId = null;

  // Reset virtual terminal for fresh session
  vterm.dispose();
  vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });

  // Brief pause for cleanup
  await new Promise((r) => setTimeout(r, 1000));

  spawnGrace = true;
  spawnClaude();
  // Clear grace period after process has had time to initialize
  setTimeout(() => { spawnGrace = false; }, 5000);
}

// ── IPC message handling ──────────────────────────────────────────────

function writeToPty(text: string): void {
  if (!claudeProcess) {
    log.error("Cannot write to PTY: no Claude process", new Error("no process"));
    return;
  }
  claudeProcess.write(text);
}

function handleIpcMessage(msg: McpToWrapper, sender: JsonLineSocket): void {
  switch (msg.type) {
    case "restart":
      log.debug(`Restart requested: ${msg.reason}`);
      restart();
      break;
    case "compact": {
      const hint = msg.hint ? ` ${msg.hint}` : "";
      log.debug(`Compact via PTY: /compact${hint}`);
      writeToPty(`/compact${hint}\r`);
      break;
    }
    case "clear":
      log.debug("Clear via PTY: /clear");
      writeToPty("/clear\r");
      break;
    case "model":
      log.debug(`Model change: ${msg.model}`);
      restart({ model: msg.model });
      break;
    case "cwd":
      log.debug(`CWD change: ${msg.cwd}`);
      restart({ cwd: msg.cwd });
      break;
    case "capture": {
      captureScreen().then((screen) => {
        log.debug(`Screen capture requested (${screen.length} chars)`);
        sender.send({ type: "capture_result", text: screen } satisfies WrapperToMcp);
      });
      break;
    }
    case "ready":
      log.debug("MCP server connected");
      sender.send({
        type: "config",
        model: state.model,
        cwd: state.cwd,
      } satisfies WrapperToMcp);
      break;
    case "input_response":
      handleInputResponse(msg.request_id, msg.answer);
      break;
  }
}

// ── IPC server ────────────────────────────────────────────────────────

createIpcServer(SOCKET_PATH, (client) => {
  mcpClients.add(client);
  client.on("message", (msg: McpToWrapper) => handleIpcMessage(msg, client));
  client.on("close", () => {
    mcpClients.delete(client);
  });
  client.on("error", () => {
    mcpClients.delete(client);
  });
});

// ── main ──────────────────────────────────────────────────────────────

generateMcpConfig();
spawnClaude();

// Graceful shutdown
function cleanup(): void {
  log.debug("Shutting down...");
  if (claudeProcess) {
    claudeProcess.kill();
  }
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
