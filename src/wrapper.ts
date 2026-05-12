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
  unlinkSync,
} from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config, loadSystemPrompt } from "./config.js";
import { log, setVerbose } from "./logger.js";
import { DATA_DIR } from "./paths.js";
import {
  createIpcServer,
  type PeerToWrapper,
  type WrapperToMcp,
  type JsonLineSocket,
  type AskQuestion,
  type AskUserQuestionInput,
} from "./ipc.js";
import { randomUUID } from "node:crypto";

setVerbose(config.verbose);

// ── paths ─────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** dist/ directory inside the installed package */
const DIST_DIR = __dirname.endsWith("src") ? join(__dirname, "..", "dist") : __dirname;

const SOCKET_PATH = join(DATA_DIR, "wrapper.sock");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── state ─────────────────────────────────────────────────────────────

interface WrapperState {
  model: string;
  cwd: string;
}

const state: WrapperState = {
  model: config.defaultModel,
  cwd: config.defaultCwd,
};

const PTY_COLS = 75;
const PTY_ROWS = 50;

let claudeProcess: pty.IPty | null = null;
const mcpClients = new Set<JsonLineSocket>();
let expectedExit = false;
let spawnGrace = false;

// ── AskUserQuestion (hook) input routing state ───────────────────────
//
// Claude Code 2.1.132 re-enabled the built-in `AskUserQuestion` tool in
// Channels mode. We detect the call via a PreToolUse hook (configured in
// ``buildArgs`` / ``ASK_USER_QUESTION_HOOK_SETTINGS``) which forwards the
// structured tool input to the wrapper over IPC before the Ink widget
// renders. The wrapper queues each question, sends it to whichever MCP
// server is connected, and translates the user's answer back into the
// keystroke sequence the Ink widget expects (arrow keys + Enter, or text
// input + Enter for the auto-added "Type something." option).

interface PendingQuestion {
  question: AskQuestion;
  /** 1-based index of this question within its AskUserQuestion call. */
  index: number;
  total: number;
}

interface ActiveInputRequest {
  id: string;
  /** Snapshot of the question we relayed (used to compute key sequences). */
  pending: PendingQuestion;
}

let activeInputRequest: ActiveInputRequest | null = null;
let inputRequestExpiry: ReturnType<typeof setTimeout> | null = null;
/** How long to hold an active input request before giving up. */
const INPUT_REQUEST_TTL_MS = 10 * 60 * 1000;
/** Questions remaining in the current AskUserQuestion call (drained as the user answers). */
const questionQueue: PendingQuestion[] = [];
/** Pacing between answering question N and presenting question N+1 — gives Ink time to advance. */
const NEXT_QUESTION_DELAY_MS = 500;
/** Extra wait for the custom-answer (free-text) path before sending Submit. */
const CUSTOM_ANSWER_INPUT_DELAY_MS = 100;
/**
 * After the final answer, Ink *may* render a "Ready to submit your answers?"
 * confirmation page (only on multi-question calls). We detect that page by
 * scanning the virtual terminal for distinctive text rather than guessing
 * from the question count — that way a single-question call where the page
 * never appears never receives a stray Enter.
 */
const SUBMIT_PAGE_PATTERN = /Submit answers|Ready to submit/i;
/** Initial delay before we start polling the screen for the Submit page. */
const SUBMIT_DETECT_INITIAL_DELAY_MS = 200;
/** Poll interval while waiting for the Submit page text to appear. */
const SUBMIT_DETECT_POLL_MS = 100;
/** Give up looking for the Submit page after this much wall-clock time. */
const SUBMIT_DETECT_TIMEOUT_MS = 1500;

// ── virtual terminal (screen buffer) ─────────────────────────────────

let vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });

/**
 * Read the current viewport (or full buffer) once, synchronously, after a flush.
 */
function readScreenOnce(all: boolean): Promise<string> {
  return new Promise((resolve) => {
    vterm.write("", () => {
      const buf = vterm.buffer.active;
      const lines: string[] = [];
      const start = all ? 0 : buf.baseY;
      const end = all ? buf.length : buf.baseY + PTY_ROWS;
      for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true).trimEnd());
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      resolve(lines.join("\n"));
    });
  });
}

/**
 * Capture current screen content from the virtual terminal.
 *
 * Flushes pending writes and retries on empty reads. Ink's in-place
 * re-render ("cursor up" + "erase to end of screen" + redraw) can arrive
 * split across PTY chunks, leaving the viewport transiently blank. A short
 * retry window rides out that gap without hiding genuinely empty screens.
 *
 * Args:
 *   all: If true, include the full scrollback history. If false
 *     (default), only the visible viewport.
 */
async function captureScreen(all = false): Promise<string> {
  const delaysMs = [40, 80];
  let screen = await readScreenOnce(all);
  for (const delay of delaysMs) {
    if (screen.length > 0) return screen;
    await new Promise((r) => setTimeout(r, delay));
    screen = await readScreenOnce(all);
  }
  return screen;
}

// ── AskUserQuestion input routing (hook-driven) ───────────────────────

/**
 * Clear the active input request and cancel any pending TTL timer.
 */
function clearActiveInputRequest(reason: string): void {
  if (activeInputRequest === null) return;
  log.debug(`Clearing active input request ${activeInputRequest.id}: ${reason}`);
  activeInputRequest = null;
  if (inputRequestExpiry) {
    clearTimeout(inputRequestExpiry);
    inputRequestExpiry = null;
  }
}

/**
 * Render a plain-text view of the question + options for the IPC `question`
 * field (kept for log lines and channel servers that don't use the
 * structured ``widget`` payload).
 */
function renderQuestionText(pending: PendingQuestion): string {
  const { question } = pending;
  const out: string[] = [];
  if (question.header) out.push(`[${question.header}]`);
  if (pending.total > 1) out.push(`(${pending.index}/${pending.total})`);
  out.push(question.question);
  out.push("");
  for (let i = 0; i < question.options.length; i++) {
    const o = question.options[i];
    out.push(`${i + 1}. ${o.label}`);
    if (o.description) out.push(`   ${o.description}`);
  }
  return out.join("\n");
}

/**
 * Send the next question in the queue to whichever MCP servers are
 * connected, and arm the TTL timer.
 *
 * No-op when the queue is empty or another request is already in flight.
 */
function presentNextQuestion(): void {
  if (activeInputRequest) return; // already waiting on a response
  const next = questionQueue.shift();
  if (!next) return;

  if (mcpClients.size === 0) {
    // Nothing connected — drop the question and warn loudly. Without this
    // guard the wrapper would silently swallow the AskUserQuestion call,
    // leaving Claude Code stuck on the (un-rendered-to-channel) Ink widget.
    log.error(
      "AskUserQuestion fired but no MCP server is connected — Claude Code is now waiting on the Ink widget with no relay path",
      new Error("no MCP client"),
    );
    return;
  }

  const requestId = randomUUID();
  activeInputRequest = { id: requestId, pending: next };
  inputRequestExpiry = setTimeout(() => {
    log.debug(`Input request ${requestId} TTL expired`);
    activeInputRequest = null;
    inputRequestExpiry = null;
  }, INPUT_REQUEST_TTL_MS);

  const message: WrapperToMcp = {
    type: "input_request",
    request_id: requestId,
    question: renderQuestionText(next),
    widget: {
      header: next.question.header ?? null,
      question: next.question.question,
      options: next.question.options.map((o) => ({
        label: o.label,
        description: o.description ?? null,
      })),
      questionIndex: next.index,
      questionTotal: next.total,
    },
  };
  log.debug(
    `Presenting AskUserQuestion (id=${requestId}, q=${next.index}/${next.total}, options=${next.question.options.length})`,
  );
  for (const client of mcpClients) {
    client.send(message);
  }
}

/**
 * Handle a `pre_ask_user_question` IPC message from the hook-runner.
 *
 * Validates the payload, queues the questions, and presents the first one.
 * Subsequent questions wait for the previous answer to be driven into the
 * Ink widget.
 */
function handlePreAskUserQuestion(input: AskUserQuestionInput): void {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length === 0) {
    log.debug("Ignoring pre_ask_user_question with empty questions array");
    return;
  }

  // If a previous AskUserQuestion was somehow not drained (e.g. the user
  // answered it via /raw on the PTY), reset state before queuing the new one.
  if (activeInputRequest || questionQueue.length > 0) {
    log.debug(
      `Resetting AskUserQuestion queue (active=${activeInputRequest?.id ?? "none"}, pending=${questionQueue.length})`,
    );
    clearActiveInputRequest("new AskUserQuestion call superseded the old one");
    questionQueue.length = 0;
  }

  for (let i = 0; i < questions.length; i++) {
    questionQueue.push({
      question: questions[i],
      index: i + 1,
      total: questions.length,
    });
  }
  log.debug(`Queued AskUserQuestion call (${questions.length} question(s))`);
  presentNextQuestion();
}

/**
 * Build the keystroke sequence that selects the given option in the Ink
 * widget. The widget always opens with focus on row 1, so we navigate
 * downward from there.
 *
 * Args:
 *   targetIndex: 1-based option row to select.
 *
 * Returns:
 *   Bytes to write to the PTY: Down arrows + Enter.
 */
function buildSelectionKeys(targetIndex: number): string {
  const downCount = Math.max(0, targetIndex - 1);
  return "\x1b[B".repeat(downCount) + "\r";
}

/**
 * Translate a user's answer into PTY keystrokes for the Ink widget.
 *
 * The widget renders user-defined options 1..N followed by an auto-added
 * "Type something." row at position N+1 for free-form answers. Selection
 * rules:
 *   - "1".."N" → press Down (n-1) times, then Enter.
 *   - any other text → navigate to the "Type something." row (Down N times,
 *     Enter), wait for Ink to mount the text field, type the answer, Enter.
 */
/**
 * Poll the virtual terminal for the AskUserQuestion submit-confirmation page.
 *
 * Returns true as soon as the screen contains the page's distinctive text
 * ("Submit answers" or "Ready to submit"), false if the timeout elapses
 * with no match — which is the expected outcome for single-question calls
 * where Ink submits without a confirmation step.
 */
async function waitForSubmitConfirmPage(): Promise<boolean> {
  const deadline = Date.now() + SUBMIT_DETECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const screen = await readScreenOnce(false);
    if (SUBMIT_PAGE_PATTERN.test(screen)) return true;
    await new Promise((r) => setTimeout(r, SUBMIT_DETECT_POLL_MS));
  }
  return false;
}

function handleInputResponse(requestId: string, answer: string): void {
  if (!activeInputRequest || activeInputRequest.id !== requestId) {
    log.debug(
      `Ignoring stale input response (expected=${activeInputRequest?.id}, got=${requestId})`,
    );
    return;
  }

  const pending = activeInputRequest.pending;
  const optionCount = pending.question.options.length;
  const isLastQuestion = pending.index >= pending.total;
  log.debug(`Input response received (id=${requestId}): ${answer.slice(0, 100)}`);
  clearActiveInputRequest("response received");

  const trimmed = answer.trim();
  const numMatch = /^(\d+)$/.exec(trimmed);
  let consumed = false;
  let customAnswerPath = false;
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 1 && n <= optionCount) {
      writeToPty(buildSelectionKeys(n));
      consumed = true;
    }
  }

  if (!consumed) {
    // Custom-answer path: navigate to "Type something." (row optionCount+1),
    // Enter to mount the text input, type, Enter to submit. The 100ms gap
    // gives Ink time to mount the input field — without it the first few
    // characters of the answer are sometimes dropped.
    const customAnswerIndex = optionCount + 1;
    writeToPty(buildSelectionKeys(customAnswerIndex));
    setTimeout(() => writeToPty(`${answer}\r`), CUSTOM_ANSWER_INPUT_DELAY_MS);
    customAnswerPath = true;
  }

  if (isLastQuestion) {
    // After the final answer Ink *may* render "Ready to submit your
    // answers?" (multi-question calls only). Scan the screen for the
    // page's distinctive text — if it appears, press Enter to confirm;
    // if not, this was a single-question call that Ink auto-submitted
    // and the wrapper has nothing to do.
    const startDelay = customAnswerPath
      ? CUSTOM_ANSWER_INPUT_DELAY_MS + SUBMIT_DETECT_INITIAL_DELAY_MS
      : SUBMIT_DETECT_INITIAL_DELAY_MS;
    setTimeout(() => {
      waitForSubmitConfirmPage()
        .then((found) => {
          if (found) {
            log.debug("Submit confirmation page detected — pressing Enter");
            writeToPty("\r");
          } else {
            log.debug("No submit confirmation page within wait window — assuming auto-submitted");
          }
        })
        .catch((err) => {
          log.error("Submit-page detection failed", err);
        });
    }, startDelay);
    return;
  }

  // Pace the next question so Ink finishes the page transition before the
  // user sees a fresh prompt on Discord / Slack.
  setTimeout(presentNextQuestion, NEXT_QUESTION_DELAY_MS);
}

/**
 * Handle an MCP server giving up on an input request.
 *
 * Without this, a dropped prompt (e.g. no active channel, send failed)
 * left the slot set until the TTL expired — blocking every subsequent
 * AskUserQuestion call for 10 minutes.
 */
function handleInputRequestFailed(requestId: string, reason: string): void {
  if (!activeInputRequest || activeInputRequest.id !== requestId) {
    log.debug(
      `Ignoring stale failure notice (expected=${activeInputRequest?.id}, got=${requestId})`,
    );
    return;
  }
  log.debug(`Input request ${requestId} failed: ${reason}`);
  clearActiveInputRequest(`failed: ${reason}`);
  // Drop the rest of the call too — without a path to the user we can't
  // collect the remaining answers either.
  questionQueue.length = 0;
}

// ── MCP server registration ───────────────────────────────────────────
//
// Claude Code 2.1.x has a regression where MCP servers loaded via
// `--mcp-config` are not visible to `--dangerously-load-development-channels`
// at startup, producing "no MCP server configured with that name" errors.
// Workaround: register each server in the project's local scope via
// `claude mcp add-json` before spawning, so it's resolvable when channels
// initialize. Entries are removed at shutdown; any leftovers from a previous
// crash are cleared before each registration.

interface McpServerSpec {
  name: string;
  json: string;
}

/** Track cwds where we have registered MCP servers, for shutdown cleanup. */
const registeredCwds = new Set<string>();

function getMcpServerSpecs(): McpServerSpec[] {
  const specs: McpServerSpec[] = [];

  if (config.discordBotToken) {
    specs.push({
      name: "discord-bot",
      json: JSON.stringify({
        command: "node",
        args: [join(DIST_DIR, "mcp-server.js")],
        env: {
          DISCORD_BOT_TOKEN: config.discordBotToken,
          WRAPPER_SOCKET: SOCKET_PATH,
          ALLOWED_CHANNEL_IDS: config.allowedChannelIds.join(","),
          FETCH_MESSAGE_LIMIT: String(config.fetchMessageLimit),
          VERBOSE: String(config.verbose),
        },
      }),
    });
  }

  if (config.slackBotToken) {
    specs.push({
      name: "slack-bot",
      json: JSON.stringify({
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
      }),
    });
  }

  return specs;
}

/**
 * Run a `claude mcp ...` subcommand in the given cwd.
 *
 * Tries the resolved Claude path first, then falls back to invoking via the
 * user's shell so aliases continue to work. Returns true on success.
 *
 * Detaches the child into its own process group and discards stdin so any
 * interactive prompt (workspace trust, auth) can't suspend the wrapper via
 * SIGTTIN/SIGTTOU.
 */
function runClaudeMcpCommand(args: string[], cwd: string): boolean {
  const opts = {
    cwd,
    stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[],
    detached: true,
    timeout: 30_000,
  };

  if (resolvedClaudePath) {
    try {
      execFileSync(resolvedClaudePath, args, opts);
      return true;
    } catch {
      // fall through to shell invocation
    }
  }

  const shell = process.env.SHELL || "/bin/bash";
  const cmdLine = [config.claudePath, ...args].map(shellEscape).join(" ");
  try {
    execSync(`${shell} -ic ${shellEscape(cmdLine)}`, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill stale mcp-server processes from previous wrapper runs.
 *
 * Claude Code spawns MCP servers as detached children, and on Claude Code
 * SIGKILL the children don't always receive a clean SIGTERM. They survive
 * holding onto Discord Gateway / Slack Socket Mode connections, hijack a
 * portion of inbound messages via round-robin, and reply with stale state
 * (captureNoResponse, lost user msgs). The new wrapper's IPC server takes
 * over the socket path, but the zombies' ipc close handler may be from an
 * older build that doesn't self-exit.
 *
 * We unconditionally SIGKILL any leftover compact-bot mcp processes before
 * spawning Claude Code. Safe because legitimate same-host instances of this
 * bot are not supported (single SOCKET_PATH).
 */
function killStaleMcpServers(): void {
  const distMcp = join(DIST_DIR, "mcp-server.js");
  const distSlack = join(DIST_DIR, "slack-mcp-server.js");
  for (const target of [distMcp, distSlack]) {
    try {
      execSync(`pkill -9 -f ${shellEscape(target)}`, {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 2000,
      });
      log.debug(`Killed stale processes matching ${target}`);
    } catch {
      // pkill exits 1 when nothing matches — that's the healthy case
    }
  }
}

function registerMcpServers(cwd: string): void {
  const specs = getMcpServerSpecs();
  if (specs.length === 0) return;

  // Kill any leftover mcp-server processes from previous wrapper runs before
  // re-registering — otherwise zombies hold Slack/Discord connections and
  // hijack a portion of inbound messages via round-robin.
  killStaleMcpServers();

  // Remove any stale entries (e.g. from a previous crash) before re-adding.
  for (const { name } of specs) {
    runClaudeMcpCommand(["mcp", "remove", "-s", "local", name], cwd);
  }

  for (const { name, json } of specs) {
    const ok = runClaudeMcpCommand(
      ["mcp", "add-json", "-s", "local", name, json],
      cwd,
    );
    if (!ok) {
      log.error(
        `Failed to register MCP server "${name}" in ${cwd}`,
        new Error("claude mcp add-json failed"),
      );
    } else {
      log.debug(`Registered MCP server "${name}" in ${cwd}`);
    }
  }

  registeredCwds.add(cwd);
}

function unregisterMcpServers(cwd: string): void {
  const specs = getMcpServerSpecs();
  for (const { name } of specs) {
    runClaudeMcpCommand(["mcp", "remove", "-s", "local", name], cwd);
  }
}

function unregisterAllMcpServers(): void {
  for (const cwd of registeredCwds) {
    unregisterMcpServers(cwd);
  }
  registeredCwds.clear();
}

// ── Claude Code lifecycle ─────────────────────────────────────────────

const HOOK_RUNNER_PATH = join(DIST_DIR, "hook-runner.js");

/**
 * Build a JSON settings blob that wires our PreToolUse hook for
 * AskUserQuestion. Claude Code merges this with the user's regular
 * settings, so existing hooks are preserved.
 */
function buildAskUserQuestionHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [
            {
              type: "command",
              command: `node ${shellEscape(HOOK_RUNNER_PATH)}`,
              timeout: 3,
            },
          ],
        },
      ],
    },
  });
}

function buildArgs(): string[] {
  const channels: string[] = [];
  if (config.discordBotToken) channels.push("server:discord-bot");
  if (config.slackBotToken) channels.push("server:slack-bot");

  const args = [
    ...(config.dangerouslySkipPermissions
      ? ["--dangerously-skip-permissions"]
      : []),
    "--dangerously-load-development-channels",
    ...channels,
    ...(state.model ? ["--model", state.model] : []),
    "--settings",
    buildAskUserQuestionHookSettings(),
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
  registerMcpServers(state.cwd);
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
    env: {
      ...process.env,
      // Exposed so the PreToolUse hook can reach the wrapper's IPC socket.
      COMPACT_BOT_WRAPPER_SOCKET: SOCKET_PATH,
    } as Record<string, string>,
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

    // AskUserQuestion is captured via a PreToolUse hook (see
    // ``buildAskUserQuestionHookSettings``), not by scraping this stream —
    // the hook receives the structured questions/options before Ink even
    // begins rendering, so the wrapper has clean data without parsing the
    // PTY. Selection keystrokes go back through ``writeToPty``.

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

  clearActiveInputRequest("restart");
  questionQueue.length = 0;

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

function handleIpcMessage(msg: PeerToWrapper, sender: JsonLineSocket): void {
  switch (msg.type) {
    case "restart":
      log.debug(`Restart requested: ${msg.reason}`);
      restart();
      break;
    case "pre_ask_user_question":
      log.debug(
        `pre_ask_user_question received (${msg.tool_input?.questions?.length ?? 0} question(s))`,
      );
      handlePreAskUserQuestion(msg.tool_input);
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
    case "esc":
      // Safety net — sends the ESC key to interrupt whatever Claude Code
      // is doing. Useful when a tool call or prompt gets stuck and the
      // user needs to break the session without a full restart.
      log.debug("ESC via PTY");
      writeToPty("\x1b");
      break;
    case "raw":
      // Pass-through — type the given text into the CLI verbatim,
      // followed by Enter. Lets the user run any CLI command that
      // isn't explicitly wired into the bot (e.g. /agents, /config).
      log.debug(`Raw PTY input: ${msg.text.slice(0, 80)}`);
      writeToPty(`${msg.text}\r`);
      break;
    case "goal":
      // /goal is a CLI-handled inline command (Claude Code 2.1.139+).
      // The CLI loops turns until the stated condition is met; `/goal clear`
      // exits the mode. We just forward the raw arg string to the PTY.
      log.debug(`Goal via PTY: /goal ${msg.args.slice(0, 80)}`);
      writeToPty(`/goal ${msg.args}\r`);
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
      captureScreen(msg.all === true).then((screen) => {
        log.debug(`Screen capture requested (all=${msg.all === true}, ${screen.length} chars)`);
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
    case "input_request_failed":
      handleInputRequestFailed(msg.request_id, msg.reason);
      break;
  }
}

// ── IPC server ────────────────────────────────────────────────────────

createIpcServer(SOCKET_PATH, (client) => {
  mcpClients.add(client);
  client.on("message", (msg: PeerToWrapper) => handleIpcMessage(msg, client));
  client.on("close", () => {
    mcpClients.delete(client);
  });
  client.on("error", () => {
    mcpClients.delete(client);
  });
});

// ── main ──────────────────────────────────────────────────────────────

spawnClaude();

// Graceful shutdown
function cleanup(): void {
  log.debug("Shutting down...");
  if (claudeProcess) {
    claudeProcess.kill();
  }
  unregisterAllMcpServers();
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // ignore
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
