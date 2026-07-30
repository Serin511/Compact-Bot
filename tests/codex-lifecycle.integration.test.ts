import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer } from "../src/codex-app-server.js";

type FixtureEvent = Record<string, unknown>;

function readEvents(path: string): FixtureEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureEvent);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("fixture condition timed out");
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

describe("Codex app-server process-group lifecycle", () => {
  let backend: CodexAppServer | null = null;
  let tempDir = "";
  let logPath = "";

  afterEach(async () => {
    await backend?.stop().catch(() => {});
    backend = null;

    // A failing assertion must not leave a fixture worker holding its Unix
    // socket. PIDs are written only by children created in this test.
    for (const event of logPath ? readEvents(logPath) : []) {
      if (event.event !== "mcp-start" || typeof event.pid !== "number") continue;
      if (isProcessGone(event.pid)) continue;
      try {
        process.kill(event.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
    logPath = "";
  });

  const lifecycleIt = process.platform === "win32" ? it.skip : it;

  lifecycleIt(
    "SIGKILLs a SIGTERM-ignoring MCP child before the replacement acquires its lock",
    async () => {
      tempDir = mkdtempSync(join(tmpdir(), "cbi-"));
      logPath = join(tempDir, "events.jsonl");
      const lockPath = join(tempDir, "realtime.sock");
      const ignoreMarker = join(tempDir, "ignored-once.marker");
      const mcpWorker = join(tempDir, "fake-mcp.mjs");
      const appServer = join(tempDir, "fake-codex.mjs");

      writeFileSync(
        mcpWorker,
        `#!/usr/bin/env node
import net from "node:net";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
const log = (event) => appendFileSync(
  process.env.FIXTURE_LOG,
  JSON.stringify({ ...event, owner: Number(process.env.OWNER_PID) }) + "\\n",
);
const lockPath = process.env.FIXTURE_LOCK;
const ignoreTermination = process.env.IGNORE_TERMINATION === "1";
const server = net.createServer();
let closing = false;
const keepAlive = setInterval(() => {}, 1000);
log({ event: "mcp-start", pid: process.pid });
server.once("error", (error) => {
  log({ event: "lock-refused", pid: process.pid, code: error.code });
});
server.listen(lockPath, () => {
  log({ event: "lock-acquired", pid: process.pid });
});
const close = (signal) => {
  if (closing) return;
  closing = true;
  log({ event: "mcp-exit", pid: process.pid, signal });
  server.close(() => {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 500).unref();
};
const ignoreAndRelease = (signal) => {
  if (closing) return;
  closing = true;
  log({ event: "mcp-signal-ignored", pid: process.pid, signal });
  server.close(() => {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {}
  });
};
process.on("SIGTERM", () => {
  if (ignoreTermination) ignoreAndRelease("SIGTERM");
  else close("SIGTERM");
});
process.on("SIGINT", () => close("SIGINT"));
process.stdin.on("end", () => {
  if (ignoreTermination) {
    log({ event: "mcp-stdin-ignored", pid: process.pid });
  } else {
    close("stdin-end");
  }
});
process.stdin.resume();
`,
      );
      chmodSync(mcpWorker, 0o755);

      writeFileSync(
        appServer,
        `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const log = (event) => appendFileSync(
  process.env.FIXTURE_LOG,
  JSON.stringify({ ...event, owner: process.pid }) + "\\n",
);
const ignoreMarker = process.env.FIXTURE_IGNORE_MARKER;
const ignoreTermination = !existsSync(ignoreMarker);
if (ignoreTermination) writeFileSync(ignoreMarker, "used");
const worker = spawn(process.execPath, [process.env.FIXTURE_MCP], {
  stdio: ["pipe", "ignore", "ignore"],
  env: {
    ...process.env,
    OWNER_PID: String(process.pid),
    IGNORE_TERMINATION: ignoreTermination ? "1" : "0",
  },
});
log({
  event: "app-start",
  pid: process.pid,
  mcpPid: worker.pid,
  ignoreTermination,
});
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
let turn = 0;
const threadId = "thread-" + process.pid;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log({ event: "request", method: message.method, params: message.params });
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture" } });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
        thread: { id: threadId },
        model: "gpt-test",
        reasoningEffort: "high",
      },
    });
  } else if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "high" },
          ],
        }],
        nextCursor: null,
      },
    });
  } else if (message.method === "turn/start") {
    turn += 1;
    send({ id: message.id, result: { turn: { id: "turn-" + turn } } });
  } else if (
    message.method === "thread/goal/clear" ||
    message.method === "turn/interrupt" ||
    message.method === "thread/unsubscribe"
  ) {
    send({ id: message.id, result: {} });
  }
});
`,
      );
      chmodSync(appServer, 0o755);

      backend = new CodexAppServer({
        executable: appServer,
        cwd: tempDir,
        model: "gpt-test",
        effort: "high",
        dangerouslySkipPermissions: false,
        developerInstructions: "fixture prompt",
        mcpServers: [],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          FIXTURE_LOG: logPath,
          FIXTURE_LOCK: lockPath,
          FIXTURE_MCP: mcpWorker,
          FIXTURE_IGNORE_MARKER: ignoreMarker,
        },
        onQuestion: async () => "",
      });

      await backend.start();
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) => event.event === "lock-acquired",
          ).length === 1,
      );
      await backend.submitText("keep the turn active");

      const firstEvents = readEvents(logPath);
      const firstApp = firstEvents.find((event) => event.event === "app-start");
      const firstMcp = firstEvents.find((event) => event.event === "mcp-start");
      if (
        typeof firstApp?.pid !== "number" ||
        typeof firstMcp?.pid !== "number"
      ) {
        throw new Error("fixture did not report its initial PIDs");
      }

      const restartStartedAt = Date.now();
      await backend.newSession();
      const restartElapsedMs = Date.now() - restartStartedAt;
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) => event.event === "lock-acquired",
          ).length === 2,
      );

      const events = readEvents(logPath);
      const appStarts = events.filter((event) => event.event === "app-start");
      const mcpStarts = events.filter((event) => event.event === "mcp-start");
      const cleanupRequests = events
        .filter(
          (event) =>
            event.event === "request" && event.owner === firstApp.pid,
        )
        .map((event) => event.method)
        .filter((method) =>
          method === "thread/goal/clear" ||
          method === "turn/interrupt" ||
          method === "thread/unsubscribe"
        );

      expect(appStarts).toHaveLength(2);
      expect(mcpStarts).toHaveLength(2);
      expect(events.filter((event) => event.event === "lock-refused")).toEqual(
        [],
      );
      expect(cleanupRequests).toEqual([
        "thread/goal/clear",
        "turn/interrupt",
        "thread/unsubscribe",
      ]);
      expect(
        events.some(
          (event) =>
            event.event === "mcp-signal-ignored" &&
            event.pid === firstMcp.pid &&
            event.signal === "SIGTERM",
        ),
      ).toBe(true);
      // The leader exits immediately, but stop() must keep watching the old
      // process group and deliver SIGKILL after the five-second grace period.
      expect(restartElapsedMs).toBeGreaterThanOrEqual(4_800);
      await waitFor(
        () => isProcessGone(firstApp.pid as number) &&
          isProcessGone(firstMcp.pid as number),
      );
      expect(backend.currentThreadId).not.toBe(`thread-${firstApp.pid}`);
    },
    15_000,
  );
});
