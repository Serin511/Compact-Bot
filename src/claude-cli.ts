/**
 * Claude Code CLI subprocess manager.
 *
 * Spawns `claude -p` in print mode with stream-json output and provides
 * an async iterator interface for consuming streamed events.
 *
 * Exports:
 *   callClaude, runClaudeSync, StreamEvent, ClaudeCallOptions, ClaudeResult.
 *
 * Example:
 *   >>> for await (const event of callClaude({ prompt: "hello" })) {
 *   >>>   console.log(event);
 *   >>> }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { config, DEFAULT_ALLOWED_TOOLS } from "./config.js";
import { log } from "./logger.js";

export interface ClaudeCallOptions {
  prompt: string;
  resume?: string;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  signal?: AbortSignal;
}

export interface StreamEvent {
  type: "system" | "stream_event" | "result";
  subtype?: string;
  session_id?: string;
  event?: {
    type: string;
    index?: number;
    delta?: {
      type: string;
      text?: string;
      partial_json?: string;
      thinking?: string;
    };
    content_block?: {
      type: string;
      name?: string;
      id?: string;
      text?: string;
      tool_use_id?: string;
      content?: unknown;
    };
  };
  is_error?: boolean;
  stop_reason?: string;
  result?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  uuid?: string;
}

export interface ClaudeResult {
  sessionId: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

function buildArgs(opts: ClaudeCallOptions): string[] {
  const args = [
    "--dangerously-skip-permissions",
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.model) args.push("--model", opts.model);
  if (opts.maxTurns != null && opts.maxTurns > 0) {
    args.push("--max-turns", String(opts.maxTurns));
  }
  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  const tools = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  if (tools.length > 0) {
    args.push("--allowedTools", ...tools);
  }

  return args;
}

/**
 * Spawn claude CLI and yield StreamEvent objects as they arrive.
 *
 * Args:
 *   opts: CLI call options including prompt, resume session, etc.
 *
 * Yields:
 *   StreamEvent objects parsed from each line of stream-json output.
 *
 * Raises:
 *   Error: If the CLI process exits with a non-zero code.
 */
export async function* callClaude(
  opts: ClaudeCallOptions,
): AsyncGenerator<StreamEvent> {
  const args = buildArgs(opts);
  const cwd = opts.cwd ?? config.defaultCwd;

  if (opts.signal?.aborted) return;

  const child: ChildProcess = spawn(config.claudePath, args, {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdin?.end();

  const onAbort = () => child.kill("SIGTERM");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const rl = createInterface({ input: child.stdout! });
  let stderr = "";

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderr += text;
    log.stderr(text);
  });

  try {
    let receivedResult = false;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const event: StreamEvent = JSON.parse(line);
        if (event.type === "result") receivedResult = true;
        yield event;
      } catch {
        // Skip unparseable lines
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
      } else {
        child.on("close", resolve);
      }
    });

    if (exitCode !== 0 && exitCode !== null) {
      // SIGTERM (143) from user cancellation — caller handles via signal check
      if (exitCode === 143 && opts.signal?.aborted) return;
      // If we received a result event, the exit code reflects the CLI's
      // stop reason (max-turns, timeout, etc.) rather than a crash.
      // The caller checks the result subtype to decide how to proceed.
      if (receivedResult) return;
      throw new Error(
        `Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
      );
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}

/**
 * Run claude CLI synchronously and return the aggregated result.
 *
 * Args:
 *   opts: CLI call options.
 *
 * Returns:
 *   ClaudeResult with session ID, full text, and token counts.
 */
export async function runClaudeSync(
  opts: ClaudeCallOptions,
): Promise<ClaudeResult> {
  let sessionId = "";
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const event of callClaude(opts)) {
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      sessionId = event.session_id;
    }

    if (event.type === "result") {
      text = event.result ?? "";
      inputTokens = event.usage?.input_tokens ?? 0;
      outputTokens = event.usage?.output_tokens ?? 0;
    }
  }

  return { sessionId, text, inputTokens, outputTokens };
}
