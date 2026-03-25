/**
 * Wrapper: manages Claude Code lifecycle with node-pty.
 *
 * Spawns Claude Code in interactive mode with a pseudo-terminal,
 * registers the MCP channel plugin, and handles restart signals
 * from the MCP server for /new, /clear, /compact, /model, /cwd.
 *
 * Exports:
 *   None (side-effect: starts wrapper process).
 *
 * Example:
 *   >>> npx tsx src/wrapper.ts
 */

import "dotenv/config";
import pty from "node-pty";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { config, loadSystemPrompt } from "./config.js";
import { log, setVerbose } from "./logger.js";
import {
  createIpcServer,
  type McpToWrapper,
  type WrapperToMcp,
  type JsonLineSocket,
} from "./ipc.js";

setVerbose(config.verbose);

// ── paths ─────────────────────────────────────────────────────────────

const DATA_DIR = join(process.cwd(), "data");
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

let claudeProcess: pty.IPty | null = null;
let mcpClient: JsonLineSocket | null = null;
let restarting = false;

// ── MCP config generation ─────────────────────────────────────────────

function generateMcpConfig(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const mcpConfig = {
    mcpServers: {
      "discord-bot": {
        command: "node",
        args: [join(process.cwd(), "dist", "mcp-server.js")],
        env: {
          DISCORD_BOT_TOKEN: config.discordBotToken,
          WRAPPER_SOCKET: SOCKET_PATH,
          ALLOWED_CHANNEL_IDS: config.allowedChannelIds.join(","),
          FETCH_MESSAGE_LIMIT: String(config.fetchMessageLimit),
          VERBOSE: String(config.verbose),
        },
      },
    },
  };

  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(mcpConfig, null, 2));
}

// ── Claude Code lifecycle ─────────────────────────────────────────────

function buildArgs(): string[] {
  const args = [
    "--dangerously-skip-permissions",
    "--mcp-config",
    MCP_CONFIG_PATH,
    "--dangerously-load-development-channels",
    "server:discord-bot",
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

function spawnClaude(): void {
  const args = buildArgs();

  const channels =
    config.allowedChannelIds.length > 0
      ? config.allowedChannelIds.join(", ")
      : "all";
  log.ready("wrapper", state.model, state.cwd, channels);

  claudeProcess = pty.spawn(config.claudePath, args, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd: state.cwd,
    env: process.env as Record<string, string>,
  });

  claudeProcess.onData((data) => {
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
  mcpClient = null;

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

function handleIpcMessage(msg: McpToWrapper): void {
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
    case "ready":
      log.debug("MCP server connected");
      mcpClient?.send({
        type: "config",
        model: state.model,
        cwd: state.cwd,
      } satisfies WrapperToMcp);
      break;
  }
}

// ── IPC server ────────────────────────────────────────────────────────

createIpcServer(SOCKET_PATH, (client) => {
  mcpClient = client;
  client.on("message", (msg: McpToWrapper) => handleIpcMessage(msg));
  client.on("close", () => {
    mcpClient = null;
  });
  client.on("error", () => {
    mcpClient = null;
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
