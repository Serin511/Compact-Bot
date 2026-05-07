/**
 * Tests for the PreToolUse hook runner.
 *
 * The hook is a one-shot subprocess Claude Code spawns when AskUserQuestion
 * is about to fire. It reads the JSON tool event from stdin, forwards the
 * structured ``tool_input`` to the wrapper over the local socket, and exits
 * with an empty (allow) decision on stdout.
 *
 * These tests exercise the script end-to-end: spin up a stub IPC server,
 * pipe a synthetic event into the runner, and assert that the wrapper saw
 * the expected ``pre_ask_user_question`` payload.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_RUNNER_SRC = pathResolve(__dirname, "..", "src", "hook-runner.ts");
const TSX_BIN = pathResolve(__dirname, "..", "node_modules", ".bin", "tsx");

interface CapturedConn {
  lines: string[];
}

function startStubWrapper(socketPath: string, captured: CapturedConn[]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      const cap: CapturedConn = { lines: [] };
      captured.push(cap);
      let buf = "";
      socket.on("data", (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) cap.lines.push(line);
        }
      });
      socket.on("end", () => {
        if (buf.trim()) cap.lines.push(buf.trim());
      });
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function runHook(
  event: object | string,
  env: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [HOOK_RUNNER_SRC], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`hook-runner exited ${code}: ${stderr}`));
        return;
      }
      resolve({ stdout, code: code ?? 0 });
    });
    child.stdin.write(typeof event === "string" ? event : JSON.stringify(event));
    child.stdin.end();
  });
}

describe("hook-runner", () => {
  let tempDir: string;
  let socketPath: string;
  let server: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-hook-"));
    socketPath = join(tempDir, "wrapper.sock");
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("forwards AskUserQuestion tool_input to the wrapper socket", async () => {
    const captured: CapturedConn[] = [];
    server = await startStubWrapper(socketPath, captured);

    const event = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "어디까지 진행할까요?",
            header: "범위",
            options: [
              { label: "최소", description: "핵심만" },
              { label: "전체", description: "모든 항목" },
            ],
          },
        ],
      },
    };

    const result = await runHook(event, { COMPACT_BOT_WRAPPER_SOCKET: socketPath });

    // Empty-object decision = allow.
    expect(result.stdout.trim()).toBe("{}");
    expect(captured.length).toBe(1);
    expect(captured[0].lines.length).toBe(1);
    const payload = JSON.parse(captured[0].lines[0]);
    expect(payload.type).toBe("pre_ask_user_question");
    expect(payload.tool_input.questions).toHaveLength(1);
    expect(payload.tool_input.questions[0].question).toBe("어디까지 진행할까요?");
    expect(payload.tool_input.questions[0].options[0].label).toBe("최소");
  });

  it("does NOT forward when the tool is not AskUserQuestion", async () => {
    const captured: CapturedConn[] = [];
    server = await startStubWrapper(socketPath, captured);

    const result = await runHook(
      { tool_name: "Bash", tool_input: { command: "ls" } },
      { COMPACT_BOT_WRAPPER_SOCKET: socketPath },
    );

    expect(result.stdout.trim()).toBe("{}");
    expect(captured.length).toBe(0);
  });

  it("returns allow even when the wrapper socket is missing", async () => {
    // Don't start a server — the hook should still gracefully allow the call
    // rather than blocking it. This is the safety net for a stale or crashed
    // wrapper: AskUserQuestion still works (no relay), Claude Code is not stuck.
    const result = await runHook(
      {
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B" }] }] },
      },
      { COMPACT_BOT_WRAPPER_SOCKET: join(tempDir, "does-not-exist.sock") },
    );

    expect(result.stdout.trim()).toBe("{}");
    expect(result.code).toBe(0);
  });

  it("never crashes on malformed stdin", async () => {
    const captured: CapturedConn[] = [];
    server = await startStubWrapper(socketPath, captured);

    const result = await runHook("not valid json {{{", {
      COMPACT_BOT_WRAPPER_SOCKET: socketPath,
    });

    expect(result.stdout.trim()).toBe("{}");
    expect(result.code).toBe(0);
    expect(captured.length).toBe(0);
  });
});
