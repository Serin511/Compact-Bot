/**
 * Structured, colored console logger for bot events.
 *
 * Replaces raw `[DEBUG]` dumps with a Claude Code–inspired format:
 * box-drawing borders, chalk colors, and indented key-value pairs.
 *
 * Exports:
 *   log — namespace object with per-event logging methods.
 *
 * Example:
 *   >>> import { log } from "./logger.js";
 *   >>> log.message("user123", "148601125791", "hello!");
 */

import chalk from "chalk";

/* ── tiny config flag (set once from config.ts) ────────────────────── */

let _verbose = false;

/** Called once at startup to wire the verbose flag. */
export function setVerbose(enabled: boolean): void {
  _verbose = enabled;
}

/* ── helpers ───────────────────────────────────────────────────────── */

const DIM = chalk.dim;
const BOLD = chalk.bold;
const CYAN = chalk.cyan;
const GREEN = chalk.green;
const YELLOW = chalk.yellow;
const RED = chalk.red;
const MAGENTA = chalk.magenta;
const BLUE = chalk.blue;
const WHITE = chalk.white;

function ts(): string {
  return DIM(
    new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  );
}

function shortId(id: string, len = 6): string {
  return id.length > len ? "…" + id.slice(-len) : id;
}

function indent(text: string, level = 1): string {
  const pad = "  ".repeat(level);
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

function truncate(text: string, max = 120): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function ruler(width = 50): string {
  return DIM("─".repeat(width));
}

/* ── public API ────────────────────────────────────────────────────── */

export const log = {
  /* ── startup ─────────────────────────────────────────────────────── */

  ready(tag: string, model: string, cwd: string, channels: string) {
    console.log("");
    console.log(ruler());
    console.log(BOLD(GREEN("  ✦ Bot Ready")));
    console.log(indent(`${DIM("User")}     ${WHITE(tag)}`));
    console.log(indent(`${DIM("Model")}    ${CYAN(model)}`));
    console.log(indent(`${DIM("CWD")}      ${DIM(cwd)}`));
    console.log(indent(`${DIM("Channels")} ${DIM(channels)}`));
    console.log(ruler());
    console.log("");
  },

  /* ── message lifecycle ───────────────────────────────────────────── */

  /** Incoming user message. */
  message(author: string, channelId: string, content: string) {
    if (!_verbose) return;
    const preview = truncate(content, 80);
    console.log("");
    console.log(
      `${ts()} ${CYAN("●")} ${BOLD(author)} ${DIM("#" + shortId(channelId))}`,
    );
    if (preview) {
      console.log(indent(DIM(`"${preview}"`)));
    }
  },

  /** Route classification result. */
  route(type: string, args?: string) {
    if (!_verbose) return;
    const argsStr = args ? DIM(` → ${truncate(args, 60)}`) : "";
    console.log(indent(`${DIM("↳")} ${MAGENTA(type)}${argsStr}`));
  },

  /** Channel not in allowlist. */
  channelBlocked(channelId: string) {
    if (!_verbose) return;
    console.log(
      `${ts()} ${DIM("○")} ${DIM("blocked #" + shortId(channelId))}`,
    );
  },

  /* ── tool calls ──────────────────────────────────────────────────── */

  /** Claude tool invocation. */
  tool(name: string, params: unknown) {
    if (!_verbose) return;
    console.log("");
    console.log(indent(`${YELLOW("▶")} ${BOLD(name)}`));

    if (params && typeof params === "object" && !Array.isArray(params)) {
      for (const [key, value] of Object.entries(
        params as Record<string, unknown>,
      )) {
        const valStr =
          typeof value === "string" ? value : JSON.stringify(value);
        console.log(indent(`${DIM(key + ":")} ${truncate(valStr, 200)}`, 2));
      }
    }
  },

  /** Tool result summary. */
  toolResult(toolId: string, content?: string) {
    if (!_verbose) return;
    if (content) {
      console.log(indent(`${DIM("←")} ${DIM(truncate(content, 200))}`, 2));
    }
  },

  /* ── thinking ────────────────────────────────────────────────────── */

  thinking(text: string) {
    if (!_verbose) return;
    console.log("");
    console.log(indent(`${BLUE("💭")} ${DIM("thinking")}`));
    const preview = truncate(text, 300);
    console.log(indent(DIM(preview), 2));
  },

  /* ── usage / lifecycle ───────────────────────────────────────────── */

  /** Token usage after a turn. */
  usage(input: number, output: number) {
    if (!_verbose) return;
    console.log(
      indent(
        `${DIM("◇")} ${DIM(`${input.toLocaleString()} in / ${output.toLocaleString()} out`)}`,
      ),
    );
  },

  /** Process cancelled via reaction. */
  cancel(channelId: string) {
    if (!_verbose) return;
    console.log(
      `\n${ts()} ${YELLOW("⚠")} ${YELLOW("Cancelled")} ${DIM("#" + shortId(channelId))}`,
    );
  },

  /** Retry via reaction. */
  retry(messageId: string, channelId: string) {
    if (!_verbose) return;
    console.log(
      `\n${ts()} ${CYAN("↻")} ${CYAN("Retry")} ${DIM("msg=" + shortId(messageId))} ${DIM("#" + shortId(channelId))}`,
    );
  },

  /* ── stderr / errors ─────────────────────────────────────────────── */

  /** stderr line from CLI subprocess. */
  stderr(text: string) {
    if (!_verbose) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    console.log(indent(`${DIM("stderr ▸")} ${DIM(trimmed)}`, 2));
  },

  /** Unhandled or important error. */
  error(context: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${ts()} ${RED("✖")} ${RED(context)} ${DIM(message)}`);
  },

  /** Generic debug fallback — use sparingly. */
  debug(...args: unknown[]) {
    if (!_verbose) return;
    console.log(ts(), DIM("…"), ...args);
  },
};
