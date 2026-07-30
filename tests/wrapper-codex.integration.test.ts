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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  connectToWrapper,
  type JsonLineSocket,
  type WrapperToMcp,
} from "../src/ipc.js";

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
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("wrapper fixture condition timed out");
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

describe("Codex wrapper runtime integration", () => {
  let wrapper: ChildProcess | null = null;
  let peer: JsonLineSocket | null = null;
  let extraPeers: JsonLineSocket[] = [];
  let tempDir = "";
  let logPath = "";

  afterEach(async () => {
    peer?.destroy();
    peer = null;
    for (const extraPeer of extraPeers) extraPeer.destroy();
    extraPeers = [];
    if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) {
      wrapper.kill("SIGTERM");
      await Promise.race([
        once(wrapper, "exit"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (wrapper.exitCode === null && wrapper.signalCode === null) {
        wrapper.kill("SIGKILL");
      }
    }
    wrapper = null;

    for (const event of logPath ? readEvents(logPath) : []) {
      if (event.event !== "app-start" || typeof event.pid !== "number") continue;
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

  it(
    "reloads system-prompt.txt when a fresh Codex runtime replaces the old one",
    async () => {
      tempDir = mkdtempSync(join(tmpdir(), "cbw-"));
      logPath = join(tempDir, "requests.jsonl");
      const fakeCodex = join(tempDir, "fake-codex.mjs");
      const promptPath = join(tempDir, "system-prompt.txt");
      const xdgHome = join(tempDir, "xdg");
      const socketPath = join(
        xdgHome,
        "compact-bot",
        "data",
        "wrapper.sock",
      );
      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoDir = dirname(testDir);
      const tsxCli = join(repoDir, "node_modules", "tsx", "dist", "cli.mjs");
      const wrapperSource = join(repoDir, "src", "wrapper.ts");

      writeFileSync(promptPath, "PROMPT_VERSION_A");
      writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex fixture 1.0\\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("fixture app-server help\\n");
  process.exit(0);
}
const { appendFileSync } = await import("node:fs");
const readline = (await import("node:readline")).default;
const log = (event) => appendFileSync(
  process.env.FIXTURE_LOG,
  JSON.stringify({ ...event, owner: process.pid }) + "\\n",
);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
const threadId = "thread-" + process.pid;
log({ event: "app-start", pid: process.pid });
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
  }
});
`,
      );
      chmodSync(fakeCodex, 0o755);

      const output: string[] = [];
      wrapper = spawn(process.execPath, [tsxCli, wrapperSource], {
        cwd: tempDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          NODE_ENV: "test",
          XDG_CONFIG_HOME: xdgHome,
          AGENT_PROVIDER: "codex",
          CODEX_PATH: fakeCodex,
          DISCORD_BOT_TOKEN: "fixture-discord-token",
          SLACK_BOT_TOKEN: "",
          SLACK_APP_TOKEN: "",
          DEFAULT_MODEL: "gpt-test",
          DEFAULT_REASONING_EFFORT: "high",
          DEFAULT_CWD: tempDir,
          SYSTEM_PROMPT_PATH: promptPath,
          FIXTURE_LOG: logPath,
          VERBOSE: "false",
        },
      });
      wrapper.stdout?.setEncoding("utf-8");
      wrapper.stderr?.setEncoding("utf-8");
      wrapper.stdout?.on("data", (chunk: string) => output.push(chunk));
      wrapper.stderr?.on("data", (chunk: string) => output.push(chunk));

      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" && event.method === "thread/start",
          ).length === 1 &&
          existsSync(socketPath),
      );
      peer = await connectToWrapper(socketPath);

      const firstStart = readEvents(logPath).find(
        (event) =>
          event.event === "request" && event.method === "thread/start",
      );
      const firstOwner = firstStart?.owner;
      expect(firstStart?.params).toMatchObject({
        developerInstructions: expect.stringContaining("PROMPT_VERSION_A"),
      });

      writeFileSync(promptPath, "PROMPT_VERSION_B");
      peer.send({
        type: "restart",
        reason: "new",
        request_id: "restart-for-prompt-reload",
        origin: {
          source: "discord",
          chat_id: "channel-1",
          message_id: "message-1",
          user: "user-1",
        },
        success_message: "restarted",
      });

      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" && event.method === "thread/start",
          ).length === 2,
      );
      const starts = readEvents(logPath).filter(
        (event) =>
          event.event === "request" && event.method === "thread/start",
      );
      expect(starts[1].owner).not.toBe(firstOwner);
      expect(starts[1].params).toMatchObject({
        developerInstructions: expect.stringContaining("PROMPT_VERSION_B"),
      });
      expect(
        (starts[1].params as { developerInstructions: string })
          .developerInstructions,
      ).not.toContain("PROMPT_VERSION_A");

      const slackMessages: WrapperToMcp[] = [];
      peer.on("message", (message: WrapperToMcp) => {
        slackMessages.push(message);
      });
      peer.send({ type: "ready", source: "slack" });
      await waitFor(() =>
        slackMessages.some((message) => message.type === "config")
      );
      expect(
        slackMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "restart-for-prompt-reload",
        ),
      ).toBe(false);

      const discordPeer = await connectToWrapper(socketPath);
      extraPeers.push(discordPeer);
      const discordMessages: WrapperToMcp[] = [];
      discordPeer.on("message", (message: WrapperToMcp) => {
        discordMessages.push(message);
      });
      discordPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        discordMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "restart-for-prompt-reload",
        )
      );
      expect(
        discordMessages.find(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "restart-for-prompt-reload",
        ),
      ).toMatchObject({
        type: "command_result",
        ok: true,
        origin: {
          source: "discord",
          chat_id: "channel-1",
        },
      });

      if (typeof firstOwner !== "number") {
        throw new Error(`fixture owner missing\n${output.join("")}`);
      }
      await waitFor(() => isProcessGone(firstOwner));
    },
    15_000,
  );
});
