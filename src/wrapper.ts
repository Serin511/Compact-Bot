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
let restarting = false;

// ── virtual terminal (screen buffer) ─────────────────────────────────

let vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS });

/**
 * Capture current screen content from the virtual terminal.
 *
 * Reads the active buffer and returns non-empty lines as plain text.
 */
function captureScreen(): string {
  const buf = vterm.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
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
    "--dangerously-skip-permissions",
    "--mcp-config",
    MCP_CONFIG_PATH,
    "--dangerously-load-development-channels",
    ...channels,
    "--model",
    state.model,
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

function validateExecutable(resolved: string): void {
  if (!existsSync(resolved)) {
    log.error(`Claude CLI not found at resolved path: ${resolved}`, new Error("not found"));
    console.error(
      `\n  Claude CLI를 찾을 수 없습니다: ${resolved}\n` +
      `  설치: https://docs.anthropic.com/en/docs/claude-code\n` +
      `  또는 CLAUDE_PATH 환경변수에 전체 경로를 설정하세요.\n`,
    );
    process.exit(1);
  }
  try {
    accessSync(resolved, fsConstants.X_OK);
  } catch {
    log.error(`Claude CLI is not executable: ${resolved}`, new Error("permission denied"));
    console.error(
      `\n  Claude CLI에 실행 권한이 없습니다: ${resolved}\n` +
      `  실행 권한 부여: chmod +x ${resolved}\n`,
    );
    process.exit(1);
  }
}

function resolveClaudePath(): string {
  const p = config.claudePath;
  if (p.includes("/") || p.includes("\\")) {
    validateExecutable(p);
    return p;
  }
  try {
    const resolved = execSync(`which ${p}`, { encoding: "utf-8" }).trim();
    if (!resolved) throw new Error("empty path");
    validateExecutable(resolved);
    return resolved;
  } catch (err) {
    if (err instanceof Error && err.message === "permission denied") throw err;
    log.error(`Claude CLI not found in PATH: ${p}`, new Error("not found"));
    console.error(
      `\n  Claude CLI를 찾을 수 없습니다: "${p}"\n` +
      `  설치: https://docs.anthropic.com/en/docs/claude-code\n` +
      `  또는 CLAUDE_PATH 환경변수에 전체 경로를 설정하세요.\n`,
    );
    process.exit(1);
  }
}

const resolvedClaudePath = resolveClaudePath();

function spawnClaude(): void {
  const args = buildArgs();

  const channels =
    config.allowedChannelIds.length > 0
      ? config.allowedChannelIds.join(", ")
      : "all";
  log.ready("wrapper", state.model, state.cwd, channels);

  try {
    claudeProcess = pty.spawn(resolvedClaudePath, args, {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: state.cwd,
      env: process.env as Record<string, string>,
    });
  } catch (err) {
    log.error(`Failed to spawn Claude CLI: ${resolvedClaudePath}`, err);
    console.error(
      `\n  Claude CLI 실행에 실패했습니다.\n` +
      `  경로: ${resolvedClaudePath}\n` +
      `  인수: ${args.join(" ")}\n` +
      `  CWD:  ${state.cwd}\n\n` +
      `  가능한 원인:\n` +
      `  - claude CLI가 올바르게 설치되지 않았을 수 있습니다\n` +
      `  - Node.js ${process.version}과 node-pty 호환성 문제일 수 있습니다\n` +
      `  - CLAUDE_PATH 환경변수로 정확한 경로를 지정해보세요\n`,
    );
    process.exit(1);
  }

  claudeProcess.onData((data) => {
    // Feed raw data to virtual terminal for accurate screen capture
    vterm.write(data);

    const clean = ptyToText(data);

    // Auto-confirm development channels prompt
    if (clean.includes("local development") || clean.includes("Enter to confirm")) {
      claudeProcess!.write("\r");
    }

    if (config.verbose && clean) {
      log.debug(clean);
    }
  });

  claudeProcess.onExit(({ exitCode }) => {
    log.debug(`Claude Code exited (code ${exitCode})`);
    claudeProcess = null;

    // Auto-respawn if not intentionally restarting
    if (!restarting) {
      log.error("Claude Code exited unexpectedly", new Error(`exit ${exitCode}`));
      setTimeout(() => {
        log.debug("Auto-respawning Claude Code...");
        spawnClaude();
      }, 2000);
    }
  });
}

function killClaude(): Promise<void> {
  return new Promise((resolve) => {
    if (!claudeProcess) {
      resolve();
      return;
    }
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
  restarting = true;
  if (updates) Object.assign(state, updates);

  log.debug(
    `Restarting Claude Code (model=${state.model}, cwd=${state.cwd})`,
  );

  await killClaude();
  mcpClients.clear();

  // Reset virtual terminal for fresh session
  vterm.dispose();
  vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS });

  // Brief pause for cleanup
  await new Promise((r) => setTimeout(r, 1000));

  restarting = false;
  spawnClaude();
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
      const screen = captureScreen();
      log.debug(`Screen capture requested (${screen.length} chars)`);
      sender.send({ type: "capture_result", text: screen } satisfies WrapperToMcp);
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
