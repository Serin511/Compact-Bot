import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  const ipcAuthToken = "wrapper-integration-ipc-secret";
  const hookIpcAuthToken = "wrapper-integration-hook-secret";
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
      const updatedCwd = join(tempDir, "updated-cwd");
      const xdgHome = join(tempDir, "xdg");
      const socketPath = join(
        xdgHome,
        "compact-bot",
        "data",
        "wrapper.sock",
      );
      const hookSocketPath = join(
        xdgHome,
        "compact-bot",
        "data",
        "wrapper-hook.sock",
      );
      const testDir = dirname(fileURLToPath(import.meta.url));
      const repoDir = dirname(testDir);
      const tsxCli = join(repoDir, "node_modules", "tsx", "dist", "cli.mjs");
      const wrapperSource = join(repoDir, "src", "wrapper.ts");

      writeFileSync(promptPath, "PROMPT_VERSION_A");
      mkdirSync(updatedCwd);
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
let currentTurnId = null;
log({ event: "app-start", pid: process.pid });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method && message.id === "ask_failover") {
    log({ event: "question-response", result: message.result });
    setTimeout(() => {
      send({
        id: "ask_resolved",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId: currentTurnId,
          itemId: "item_resolved",
          autoResolutionMs: null,
          questions: [{
            id: "choice",
            header: "resolved",
            question: "app-server가 먼저 종료하는 질문",
            isOther: false,
            isSecret: false,
            options: [{ label: "확인", description: "" }],
          }],
        },
      });
      setTimeout(() => {
        send({
          method: "serverRequest/resolved",
          params: { threadId, requestId: "ask_resolved" },
        });
        setTimeout(() => {
          send({
            id: "ask_failover_timeout",
            method: "item/tool/requestUserInput",
            params: {
              threadId,
              turnId: currentTurnId,
              itemId: "item_failover_timeout",
              autoResolutionMs: null,
              questions: [{
                id: "choice",
                header: "failover-timeout",
                question: "replacement owner가 없으면 bounded cancel",
                isOther: false,
                isSecret: false,
                options: [{ label: "확인", description: "" }],
              }],
            },
          });
        }, 200);
      }, 200);
    }, 500);
    return;
  }
  if (!message.method && message.id === "ask_failover_timeout") {
    log({ event: "timeout-question-response", result: message.result });
    return;
  }
  if (!message.method && message.id === "ask_resolved") {
    log({ event: "unexpected-resolved-response", result: message.result });
    return;
  }
  log({ event: "request", method: message.method, params: message.params });
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture" } });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
	        thread: { id: threadId },
	        model: "gpt-test",
	        cwd: message.params.cwd,
	        reasoningEffort: "high",
      },
    });
	  } else if (message.method === "turn/start") {
	    const turnId = "turn-" + Date.now();
	    currentTurnId = turnId;
	    send({ id: message.id, result: { turn: { id: turnId } } });
	    if (message.params.input?.[0]?.text?.includes("QUESTION_FAILOVER")) {
      send({
        id: "ask_failover",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "item_failover",
          autoResolutionMs: null,
          questions: [{
            id: "choice",
            header: "failover",
            question: "replacement owner에게 같은 요청이 전달되어야 합니다",
            isOther: false,
            isSecret: false,
            options: [
              { label: "계속", description: "" },
              { label: "중지", description: "" },
            ],
          }],
        },
	      });
	    } else if (message.params.input?.[0]?.text?.includes("STATE_SYNC")) {
	      send({
	        method: "thread/settings/updated",
	        params: {
	          threadId,
	          threadSettings: {
	            model: "gpt-rerouted",
	            cwd: process.env.UPDATED_CWD,
	            effort: "low",
	          },
	        },
	      });
	      send({
	        method: "turn/completed",
	        params: {
	          threadId,
	          turn: { id: turnId, status: "completed", error: null },
	        },
	      });
	    } else if (message.params.input?.[0]?.text?.includes("OUTBOUND_GUARD")) {
	      send({
	        method: "turn/started",
	        params: {
	          threadId,
	          turn: { id: turnId, status: "inProgress" },
	        },
	      });
	      send({
	        method: "item/started",
	        params: {
	          threadId,
	          turnId,
	          item: {
	            id: "guard-write-" + turnId,
	            type: "mcpToolCall",
	            server: "compact_bot_slack",
	            tool: "reply",
	            status: "inProgress",
	            arguments: {
	              chat_id: "channel-guard",
	              thread_ts: "guard-thread",
	              text: "guarded reply",
	            },
	            result: null,
	            error: null,
	          },
	        },
	      });
	      send({
	        method: "thread/goal/updated",
	        params: {
	          threadId,
	          goal: { objective: "native goal", status: "active" },
	        },
	      });
	      setTimeout(() => {
	        send({
	          method: "turn/completed",
	          params: {
	            threadId,
	            turn: { id: turnId, status: "completed", error: null },
	          },
	        });
	        currentTurnId = "turn-native-goal-" + Date.now();
	        send({
	          method: "turn/started",
	          params: {
	            threadId,
	            turn: { id: currentTurnId, status: "inProgress" },
	          },
	        });
	        log({ event: "native-goal-automatic-start", turnId: currentTurnId });
	      }, 750);
	    }
	  } else if (message.method === "turn/steer") {
	    send({ id: message.id, result: {} });
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
	        }, {
	          id: "gpt-rerouted",
	          model: "gpt-rerouted",
	          supportedReasoningEfforts: [
	            { reasoningEffort: "low", description: "low" },
	          ],
	        }],
	        nextCursor: null,
	      },
	    });
	  } else if (message.method === "thread/settings/update") {
	    setTimeout(() => {
	      send({ id: message.id, result: {} });
	      send({
	        method: "thread/settings/updated",
	        params: {
	          threadId,
	          threadSettings: {
	            model: "gpt-rerouted",
	            cwd: process.env.UPDATED_CWD,
	            effort: message.params.effort,
	          },
	        },
	      });
	    }, 300);
	  } else if (message.method === "thread/turns/list") {
	    setTimeout(() => {
	      send({
	        id: message.id,
	        result: {
	          data: [{
	            id: "capture-turn",
	            status: "completed",
	            items: [{
	              id: "capture-answer",
	              type: "agentMessage",
	              text: "CAPTURE_FAILOVER_CONTENT",
	            }],
	          }],
	          nextCursor: null,
	          backwardsCursor: null,
	        },
	      });
	    }, 300);
	  } else if (
	    message.method === "thread/inject_items"
	  ) {
	    send({ id: message.id, result: {} });
	  } else if (message.method === "thread/compact/start") {
	    // Acknowledge scheduling but deliberately never emit the compaction
	    // turn lifecycle. Recovery commands must not wait for its 5m barrier.
	    send({ id: message.id, result: {} });
	  } else if (message.method === "thread/goal/set") {
	    send({
	      id: message.id,
	      result: {
	        goal: {
	          threadId,
	          objective: message.params.objective,
	          status: "active",
	        },
	      },
	    });
	    send({
	      method: "thread/goal/updated",
	      params: {
	        threadId,
	        goal: {
	          objective: message.params.objective,
	          status: "active",
	        },
	      },
	    });
	    // Deliberately never emit the first automatic goal turn.
	  } else if (message.method === "turn/interrupt") {
	    send({ id: message.id, result: {} });
	    send({
	      method: "turn/completed",
	      params: {
	        threadId,
	        turn: {
	          id: message.params.turnId,
	          status: "interrupted",
	          error: null,
	        },
	      },
	    });
	  } else if (message.method === "thread/unsubscribe") {
	    send({
	      method: "item/completed",
	      params: {
	        threadId,
	        turnId: "stale-retiring-turn",
	        item: {
	          id: "stale-retiring-answer",
	          type: "agentMessage",
	          phase: "final_answer",
	          text: "STALE_RETIRING_BACKEND_REPLY",
	        },
	      },
	    });
	    send({
	      method: "turn/completed",
	      params: {
	        threadId,
	        turn: {
	          id: "stale-retiring-turn",
	          status: "completed",
	          error: null,
	        },
	      },
	    });
	    send({ id: message.id, result: {} });
	  } else if (message.method === "thread/goal/clear") {
	    send({ id: message.id, result: {} });
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
          UPDATED_CWD: updatedCwd,
          COMPACT_BOT_IPC_AUTH_TOKEN: ipcAuthToken,
          COMPACT_BOT_HOOK_IPC_AUTH_TOKEN: hookIpcAuthToken,
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
          existsSync(socketPath) &&
          existsSync(hookSocketPath),
      );
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
      await waitFor(() => (statSync(socketPath).mode & 0o777) === 0o600);
      peer = await connectToWrapper(socketPath, ipcAuthToken);
      const slackMessages: WrapperToMcp[] = [];
      peer.on("message", (message: WrapperToMcp) => {
        slackMessages.push(message);
      });

      // The Claude hook credential is intentionally least-privilege. Even a
      // process that inherits it may relay AskUserQuestion, but it cannot send
      // mutable wrapper commands such as restart/clear/cwd/goal.
      const hookPeer = await connectToWrapper(
        hookSocketPath,
        hookIpcAuthToken,
      );
      extraPeers.push(hookPeer);
      const hookClosed = once(hookPeer, "close");
      hookPeer.send({
        type: "restart",
        reason: "new",
        request_id: "must-not-run-from-hook",
      });
      await hookClosed;
      expect(
        readEvents(logPath).filter(
          (event) =>
            event.event === "request" && event.method === "thread/start",
        ),
      ).toHaveLength(1);

      const firstStart = readEvents(logPath).find(
        (event) =>
          event.event === "request" && event.method === "thread/start",
      );
      const firstOwner = firstStart?.owner;
      expect(firstStart?.params).toMatchObject({
        developerInstructions: expect.stringContaining("PROMPT_VERSION_A"),
      });

      // This peer has not announced realtime `ready`, matching an inert MCP
      // tool process. Authorization must still return directly to its socket.
      peer.send({
        type: "user_message",
        source: "slack",
        content: "OUTBOUND_GUARD",
        meta: {
          chat_id: "channel-guard",
          message_id: "guard-message",
          user_id: "guard-user",
          thread_ts: "guard-thread",
        },
      });
      await waitFor(() =>
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "turn/start" &&
            JSON.stringify(event.params).includes("OUTBOUND_GUARD"),
        )
      );
      peer.send({
        type: "authorize_outbound",
        request_id: "inert-guard-request",
        source: "slack",
        server: "compact_bot_slack",
        tool: "reply",
        arguments: {
          text: "guarded reply",
          thread_ts: "guard-thread",
          chat_id: "channel-guard",
        },
      });
      await waitFor(() =>
        slackMessages.some(
          (message) =>
            message.type === "outbound_authorization_result" &&
            message.request_id === "inert-guard-request",
        )
      );
      expect(
        slackMessages.find(
          (message) =>
            message.type === "outbound_authorization_result" &&
            message.request_id === "inert-guard-request",
        ),
      ).toMatchObject({ ok: true });

      await waitFor(() =>
        readEvents(logPath).some(
          (event) => event.event === "native-goal-automatic-start",
        )
      );
      peer.send({
        type: "raw",
        text: "SAME_ORIGIN_AFTER_NATIVE_GOAL",
        request_id: "same-origin-after-native-goal",
        origin: {
          source: "slack",
          chat_id: "channel-guard",
          message_id: "guard-message-later",
          user: "guard-user",
          thread_ts: "guard-thread",
        },
      });
      await waitFor(() =>
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "turn/steer" &&
            JSON.stringify(event.params).includes(
              "SAME_ORIGIN_AFTER_NATIVE_GOAL",
            ),
        )
      );

      peer.send({
        type: "raw",
        text: "CROSS_ORIGIN_AFTER_NATIVE_GOAL",
        request_id: "cross-origin-after-native-goal",
        origin: {
          source: "slack",
          chat_id: "channel-guard",
          message_id: "guard-message-wrong-user",
          user: "other-user",
          thread_ts: "guard-thread",
        },
      });
      peer.send({
        type: "raw",
        text: "SAME_ORIGIN_AFTER_CROSS_ORIGIN",
        request_id: "same-origin-after-cross-origin",
        origin: {
          source: "slack",
          chat_id: "channel-guard",
          message_id: "guard-message-sentinel",
          user: "guard-user",
          thread_ts: "guard-thread",
        },
      });
      await waitFor(() =>
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "turn/steer" &&
            JSON.stringify(event.params).includes(
              "SAME_ORIGIN_AFTER_CROSS_ORIGIN",
            ),
        )
      );
      expect(
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "turn/steer" &&
            JSON.stringify(event.params).includes(
              "CROSS_ORIGIN_AFTER_NATIVE_GOAL",
            ),
        ),
      ).toBe(false);

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

      const discordPeer = await connectToWrapper(socketPath, ipcAuthToken);
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

      discordPeer.send({
        type: "user_message",
        source: "discord",
        content: "STATE_SYNC",
        meta: {
          chat_id: "channel-1",
          message_id: "message-state",
          user_id: "user-1",
          ts: "2026-07-30T00:00:00.000Z",
        },
      });
      await waitFor(() =>
        discordMessages.some(
          (message) =>
            message.type === "config" &&
            message.model === "gpt-rerouted" &&
            message.effort === "low" &&
            message.cwd === updatedCwd &&
            message.availableEfforts.includes("low"),
        )
      );

      discordPeer.send({
        type: "restart",
        reason: "new",
        request_id: "restart-after-state-sync",
        origin: {
          source: "discord",
          chat_id: "channel-1",
          message_id: "message-state-restart",
          user: "user-1",
        },
        success_message: "state restarted",
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" && event.method === "thread/start",
          ).length === 3,
      );
      const thirdStart = readEvents(logPath).filter(
        (event) =>
          event.event === "request" && event.method === "thread/start",
      )[2];
      expect(thirdStart.params).toMatchObject({
        cwd: updatedCwd,
        model: "gpt-rerouted",
        config: { model_reasoning_effort: "low" },
        developerInstructions: expect.stringContaining("PROMPT_VERSION_B"),
      });

      const configCountBeforeReady = discordMessages.filter(
        (message) => message.type === "config",
      ).length;
      discordPeer.send({ type: "ready", source: "discord" });
      await waitFor(
        () =>
          discordMessages.filter((message) => message.type === "config")
            .length > configCountBeforeReady,
      );

      discordPeer.send({
        type: "user_message",
        source: "discord",
        content: "QUESTION_FAILOVER",
        meta: {
          chat_id: "channel-1",
          message_id: "message-question",
          user_id: "user-1",
          ts: "2026-07-30T00:00:00.000Z",
        },
      });
      try {
        await waitFor(() =>
          discordMessages.some(
            (message) =>
              message.type === "input_request" &&
              message.widget?.header === "failover",
          )
        );
      } catch {
        throw new Error(
          `failover input request timed out\n${JSON.stringify(readEvents(logPath))}\n${output.join("")}`,
        );
      }
      const inputRequest = discordMessages.find(
        (message) =>
          message.type === "input_request" &&
          message.widget?.header === "failover",
      );
      if (!inputRequest || inputRequest.type !== "input_request") {
        throw new Error("failover input request missing");
      }

      discordPeer.send({
        type: "raw",
        text: "CROSS_ORIGIN_STEER_MUST_NOT_RUN",
        request_id: "cross-origin-active-turn",
        origin: {
          source: "discord",
          chat_id: "channel-2",
          message_id: "message-cross-origin",
          user: "user-2",
        },
      });
      await waitFor(() =>
        discordMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "cross-origin-active-turn" &&
            !message.ok,
        )
      );
      expect(
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            JSON.stringify(event.params).includes(
              "CROSS_ORIGIN_STEER_MUST_NOT_RUN",
            ),
        ),
      ).toBe(false);

      discordPeer.send({
        type: "goal",
        args: "cross origin goal must not run",
        request_id: "cross-origin-active-goal",
        origin: {
          source: "discord",
          chat_id: "channel-2",
          message_id: "message-cross-goal",
          user: "user-2",
        },
      });
      await waitFor(() =>
        discordMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "cross-origin-active-goal" &&
            !message.ok,
        )
      );
      expect(
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "thread/goal/set" &&
            (event.params as { objective?: string } | undefined)?.objective ===
              "cross origin goal must not run",
        ),
      ).toBe(false);

      // A transient reconnect on the same adapter keeps its already-rendered
      // prompt and only restores response eligibility; it must not post a
      // duplicate request or resolve Codex early.
      const inputCountBeforeReconnect = discordMessages.filter(
        (message) =>
          message.type === "input_request" &&
          message.request_id === inputRequest.request_id,
      ).length;
      discordPeer.send({ type: "not_ready", source: "discord" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        discordMessages.some(
          (message) =>
            message.type === "input_request_cancel" &&
            message.request_id === inputRequest.request_id,
        ),
      ).toBe(false);
      expect(
        readEvents(logPath).some(
          (event) => event.event === "question-response",
        ),
      ).toBe(false);
      discordPeer.send({
        type: "input_response",
        request_id: inputRequest.request_id,
        answer: "1",
        origin: {
          source: "discord",
          chat_id: "channel-1",
          message_id: "stale-answer",
          user: "user-1",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        readEvents(logPath).some(
          (event) => event.event === "question-response",
        ),
      ).toBe(false);
      const configCountBeforeReconnect = discordMessages.filter(
        (message) => message.type === "config",
      ).length;
      discordPeer.send({ type: "ready", source: "discord" });
      await waitFor(
        () =>
          discordMessages.filter((message) => message.type === "config")
            .length > configCountBeforeReconnect,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        discordMessages.filter(
          (message) =>
            message.type === "input_request" &&
            message.request_id === inputRequest.request_id,
        ),
      ).toHaveLength(inputCountBeforeReconnect);

      // A fresh process within the grace window receives the same request ID,
      // including if it announces ready just before the old IPC socket dies.
      const replacementPeer = await connectToWrapper(
        socketPath,
        ipcAuthToken,
      );
      extraPeers.push(replacementPeer);
      const replacementMessages: WrapperToMcp[] = [];
      replacementPeer.on("message", (message: WrapperToMcp) => {
        replacementMessages.push(message);
      });
      replacementPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        replacementMessages.some((message) => message.type === "config")
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        replacementMessages.some(
          (message) =>
            message.type === "input_request" &&
            message.request_id === inputRequest.request_id,
        ),
      ).toBe(false);
      const disconnectedPeer = once(discordPeer, "close");
      discordPeer.destroy();
      await disconnectedPeer;
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "input_request" &&
            message.request_id === inputRequest.request_id,
        )
      );
      const replayedInput = replacementMessages.find(
        (message) =>
          message.type === "input_request" &&
          message.request_id === inputRequest.request_id,
      );
      expect(replayedInput).toMatchObject({
        type: "input_request",
        request_id: inputRequest.request_id,
        origin: {
          source: "discord",
          chat_id: "channel-1",
          user: "user-1",
        },
      });

      // A replacement response from the wrong user/conversation remains
      // ineligible even though the request ID is unchanged.
      replacementPeer.send({
        type: "input_response",
        request_id: inputRequest.request_id,
        answer: "1",
        origin: {
          source: "discord",
          chat_id: "channel-1",
          message_id: "wrong-user-answer",
          user: "user-2",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        readEvents(logPath).some(
          (event) => event.event === "question-response",
        ),
      ).toBe(false);

      replacementPeer.send({
        type: "input_response",
        request_id: inputRequest.request_id,
        answer: "1",
        origin: {
          source: "discord",
          chat_id: "channel-1",
          message_id: "replacement-answer",
          user: "user-1",
        },
      });
      await waitFor(() =>
        readEvents(logPath).some(
          (event) => event.event === "question-response",
        )
      );
      expect(
        readEvents(logPath).filter(
          (event) => event.event === "question-response",
        ),
      ).toHaveLength(1);
      expect(
        readEvents(logPath).find(
          (event) => event.event === "question-response",
        )?.result,
      ).toEqual({
        answers: { choice: { answers: ["계속"] } },
      });

      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "input_request" &&
            message.widget?.header === "resolved",
        )
      );
      const resolvedInput = replacementMessages.find(
        (message) =>
          message.type === "input_request" &&
          message.widget?.header === "resolved",
      );
      if (!resolvedInput || resolvedInput.type !== "input_request") {
        throw new Error("server-resolved input request missing");
      }
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "input_request_cancel" &&
            message.request_id === resolvedInput.request_id,
        )
      );
      expect(
        readEvents(logPath).some(
          (event) => event.event === "unexpected-resolved-response",
        ),
      ).toBe(false);

      // If no owner comes back, the same failover state has a hard 5s bound
      // and Codex receives a safe empty answer instead of hanging forever.
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "input_request" &&
            message.widget?.header === "failover-timeout",
        )
      );
      const timeoutInput = replacementMessages.find(
        (message) =>
          message.type === "input_request" &&
          message.widget?.header === "failover-timeout",
      );
      if (!timeoutInput || timeoutInput.type !== "input_request") {
        throw new Error("failover timeout input request missing");
      }
      replacementPeer.send({ type: "not_ready", source: "discord" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        readEvents(logPath).some(
          (event) => event.event === "timeout-question-response",
        ),
      ).toBe(false);
      await waitFor(
        () =>
          readEvents(logPath).some(
            (event) => event.event === "timeout-question-response",
          ),
        7_000,
      );
      expect(
        readEvents(logPath).find(
          (event) => event.event === "timeout-question-response",
        )?.result,
      ).toEqual({ answers: {} });
      expect(
        replacementMessages.some(
          (message) =>
            message.type === "input_request_cancel" &&
            message.request_id === timeoutInput.request_id,
        ),
      ).toBe(true);
      const replacementConfigCount = replacementMessages.filter(
        (message) => message.type === "config",
      ).length;
      replacementPeer.send({ type: "ready", source: "discord" });
      await waitFor(
        () =>
          replacementMessages.filter((message) => message.type === "config")
            .length > replacementConfigCount,
      );

      expect(
        [...slackMessages, ...discordMessages, ...replacementMessages].some(
          (message) =>
            message.type === "agent_reply" &&
            message.text.includes("STALE_RETIRING_BACKEND_REPLY"),
        ),
      ).toBe(false);

      const controlOrigin = {
        source: "discord" as const,
        chat_id: "channel-1",
        message_id: "message-control",
        user: "user-1",
      };
      const compactCountBeforeEsc = readEvents(logPath).filter(
        (event) =>
          event.event === "request" &&
          event.method === "thread/compact/start",
      ).length;
      replacementPeer.send({
        type: "compact",
        request_id: "stalled-compact-before-esc",
        origin: controlOrigin,
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" &&
              event.method === "thread/compact/start",
          ).length > compactCountBeforeEsc,
      );

      const escStartedAt = Date.now();
      const appStartCountBeforeEsc = readEvents(logPath).filter(
        (event) => event.event === "app-start",
      ).length;
      replacementPeer.send({
        type: "esc",
        request_id: "esc-stalled-compact",
        origin: controlOrigin,
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) => event.event === "app-start",
          ).length > appStartCountBeforeEsc,
      );
      expect(Date.now() - escStartedAt).toBeLessThan(2_000);
      replacementPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "esc-stalled-compact" &&
            message.ok,
          )
      );
      expect(
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "turn/interrupt",
        ),
      ).toBe(true);
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "stalled-compact-before-esc" &&
            !message.ok,
        )
      );

      replacementPeer.send({
        type: "user_message",
        source: "discord",
        content: "CONTROL_RESTART_SEED",
        meta: {
          chat_id: "channel-1",
          message_id: "message-control-seed",
          user_id: "user-1",
        },
      });
      await waitFor(() =>
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "turn/start" &&
            JSON.stringify(event.params).includes("CONTROL_RESTART_SEED"),
        )
      );

      const compactCountBeforeRestart = readEvents(logPath).filter(
        (event) =>
          event.event === "request" &&
          event.method === "thread/compact/start",
      ).length;
      replacementPeer.send({
        type: "compact",
        request_id: "stalled-compact-before-restart",
        origin: controlOrigin,
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" &&
              event.method === "thread/compact/start",
          ).length > compactCountBeforeRestart,
      );

      const appStartCountBeforeControlRestart = readEvents(logPath).filter(
        (event) => event.event === "app-start",
      ).length;
      const restartControlStartedAt = Date.now();
      replacementPeer.send({
        type: "restart",
        reason: "new",
        request_id: "restart-stalled-compact",
        origin: controlOrigin,
      });
      replacementPeer.send({
        type: "raw",
        text: "OLD_QUEUED_DURING_RESTART",
        request_id: "raw-during-restart",
        origin: controlOrigin,
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) => event.event === "app-start",
          ).length > appStartCountBeforeControlRestart,
      );
      expect(Date.now() - restartControlStartedAt).toBeLessThan(3_000);
      replacementPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "restart-stalled-compact" &&
            message.ok,
        )
      );
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "raw-during-restart" &&
            !message.ok,
        )
      );
      expect(
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            JSON.stringify(event.params).includes("OLD_QUEUED_DURING_RESTART"),
        ),
      ).toBe(false);

      const goalClearCountBefore = readEvents(logPath).filter(
        (event) =>
          event.event === "request" &&
          event.method === "thread/goal/clear",
      ).length;
      replacementPeer.send({
        type: "goal",
        args: "stalled wrapper objective",
        request_id: "stalled-goal-start",
        origin: controlOrigin,
      });
      await waitFor(() =>
        readEvents(logPath).some(
          (event) =>
            event.event === "request" &&
            event.method === "thread/goal/set" &&
            (event.params as { objective?: string } | undefined)?.objective ===
              "stalled wrapper objective",
        )
      );
      const goalClearStartedAt = Date.now();
      const appStartCountBeforeGoalClear = readEvents(logPath).filter(
        (event) => event.event === "app-start",
      ).length;
      replacementPeer.send({
        type: "goal",
        args: "clear",
        request_id: "clear-stalled-goal",
        origin: controlOrigin,
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) => event.event === "app-start",
          ).length > appStartCountBeforeGoalClear,
      );
      expect(Date.now() - goalClearStartedAt).toBeLessThan(2_000);
      replacementPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "clear-stalled-goal" &&
            message.ok,
          )
      );
      expect(
        readEvents(logPath).filter(
          (event) =>
            event.event === "request" &&
            event.method === "thread/goal/clear",
        ).length,
      ).toBeGreaterThan(goalClearCountBefore);
      await waitFor(() =>
        replacementMessages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "stalled-goal-start" &&
            !message.ok,
        )
      );

      const settingsCountBeforeFailover = readEvents(logPath).filter(
        (event) =>
          event.event === "request" &&
          event.method === "thread/settings/update",
      ).length;
      replacementPeer.send({
        type: "effort",
        request_id: "effort-result-failover",
        effort: "high",
        origin: controlOrigin,
      });
      try {
        await waitFor(
          () =>
            readEvents(logPath).filter(
              (event) =>
                event.event === "request" &&
                event.method === "thread/settings/update",
            ).length > settingsCountBeforeFailover,
        );
      } catch {
        throw new Error(
          `effort request did not reach fixture\n${
            JSON.stringify(replacementMessages.slice(-10))
          }\n${JSON.stringify(readEvents(logPath).slice(-20))}\n${output.join("")}`,
        );
      }

      const effortFailoverPeer = await connectToWrapper(
        socketPath,
        ipcAuthToken,
      );
      extraPeers.push(effortFailoverPeer);
      const effortFailoverMessages: WrapperToMcp[] = [];
      effortFailoverPeer.on("message", (message: WrapperToMcp) => {
        effortFailoverMessages.push(message);
      });
      effortFailoverPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        effortFailoverMessages.some((message) => message.type === "config")
      );
      const effortRequesterClosed = once(replacementPeer, "close");
      replacementPeer.destroy();
      await effortRequesterClosed;
      await waitFor(() =>
        effortFailoverMessages.some(
          (message) =>
            message.type === "effort_result" &&
            message.request_id === "effort-result-failover",
        )
      );
      expect(
        effortFailoverMessages.filter(
          (message) =>
            message.type === "effort_result" &&
            message.request_id === "effort-result-failover",
        ),
      ).toEqual([
        expect.objectContaining({
          type: "effort_result",
          ok: true,
          effort: "high",
          origin: controlOrigin,
        }),
      ]);
      expect(
        slackMessages.some(
          (message) =>
            message.type === "effort_result" &&
            message.request_id === "effort-result-failover",
        ),
      ).toBe(false);

      const turnsCountBeforeCrossOrigin = readEvents(logPath).filter(
        (event) =>
          event.event === "request" &&
          event.method === "thread/turns/list",
      ).length;
      effortFailoverPeer.send({
        type: "capture",
        request_id: "cross-origin-capture",
        all: true,
        origin: {
          source: "slack",
          chat_id: "wrong-platform-channel",
          message_id: "wrong-platform-message",
          user: "wrong-platform-user",
        },
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" &&
              event.method === "thread/turns/list",
          ).length > turnsCountBeforeCrossOrigin,
      );
      await waitFor(() =>
        effortFailoverMessages.some(
          (message) =>
            message.type === "capture_result" &&
            message.request_id === "cross-origin-capture",
        )
      );
      expect(
        effortFailoverMessages.find(
          (message) =>
            message.type === "capture_result" &&
            message.request_id === "cross-origin-capture",
        ),
      ).not.toHaveProperty("origin");
      expect(
        slackMessages.some(
          (message) =>
            message.type === "capture_result" &&
            message.request_id === "cross-origin-capture",
        ),
      ).toBe(false);

      const turnsCountBeforeFailover = readEvents(logPath).filter(
        (event) =>
          event.event === "request" &&
          event.method === "thread/turns/list",
      ).length;
      effortFailoverPeer.send({
        type: "capture",
        request_id: "capture-result-failover",
        all: true,
        origin: controlOrigin,
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" &&
              event.method === "thread/turns/list",
          ).length > turnsCountBeforeFailover,
      );

      const captureFailoverPeer = await connectToWrapper(
        socketPath,
        ipcAuthToken,
      );
      extraPeers.push(captureFailoverPeer);
      const captureFailoverMessages: WrapperToMcp[] = [];
      captureFailoverPeer.on("message", (message: WrapperToMcp) => {
        captureFailoverMessages.push(message);
      });
      captureFailoverPeer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        captureFailoverMessages.some((message) => message.type === "config")
      );
      const captureRequesterClosed = once(effortFailoverPeer, "close");
      effortFailoverPeer.destroy();
      await captureRequesterClosed;
      await waitFor(() =>
        captureFailoverMessages.some(
          (message) =>
            message.type === "capture_result" &&
            message.request_id === "capture-result-failover",
        )
      );
      expect(
        captureFailoverMessages.filter(
          (message) =>
            message.type === "capture_result" &&
            message.request_id === "capture-result-failover",
        ),
      ).toEqual([
        expect.objectContaining({
          type: "capture_result",
          all: true,
          origin: controlOrigin,
          text: expect.stringContaining("CAPTURE_FAILOVER_CONTENT"),
        }),
      ]);
      expect(
        slackMessages.some(
          (message) =>
            message.type === "capture_result" &&
            message.request_id === "capture-result-failover",
        ),
      ).toBe(false);

      if (typeof firstOwner !== "number") {
        throw new Error(`fixture owner missing\n${output.join("")}`);
      }
      await waitFor(() => isProcessGone(firstOwner));
    },
    30_000,
  );

  it(
    "does not exit when clear retires a runtime still loading model capabilities",
    async () => {
      // Keep the fixture root short enough for macOS' Unix-domain socket
      // length limit once `xdg/compact-bot/data/wrapper.sock` is appended.
      tempDir = mkdtempSync(join(tmpdir(), "cbw-r-"));
      logPath = join(tempDir, "requests.jsonl");
      const fakeCodex = join(tempDir, "fake-codex.mjs");
      const firstMarker = join(tempDir, "first-runtime.marker");
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

      writeFileSync(
        fakeCodex,
        `#!/usr/bin/env node
import readline from "node:readline";
import {
  appendFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
if (process.argv.includes("--version")) {
  process.stdout.write("codex fixture 1.0\\n");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write("fixture app-server help\\n");
  process.exit(0);
}
const log = (event) => appendFileSync(
  process.env.FIXTURE_LOG,
  JSON.stringify({ ...event, owner: process.pid }) + "\\n",
);
const firstRuntime = !existsSync(process.env.FIRST_MARKER);
if (firstRuntime) writeFileSync(process.env.FIRST_MARKER, "used");
const threadId = "thread-" + process.pid;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
log({ event: "app-start", firstRuntime });
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
        cwd: process.cwd(),
        reasoningEffort: "high",
      },
    });
  } else if (message.method === "model/list") {
    if (firstRuntime) {
      log({ event: "model-list-stalled" });
    } else {
      send({
        id: message.id,
        result: {
          data: [{
            id: "gpt-test",
            model: "gpt-test",
            supportedReasoningEfforts: [{
              reasoningEffort: "high",
              description: "high",
            }],
          }],
          nextCursor: null,
        },
      });
    }
  } else if (
    message.method === "thread/goal/clear" ||
    message.method === "thread/unsubscribe" ||
    message.method === "turn/interrupt"
  ) {
    send({ id: message.id, result: {} });
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
          FIXTURE_LOG: logPath,
          FIRST_MARKER: firstMarker,
          COMPACT_BOT_IPC_AUTH_TOKEN: ipcAuthToken,
          COMPACT_BOT_HOOK_IPC_AUTH_TOKEN: hookIpcAuthToken,
          VERBOSE: "false",
        },
      });
      wrapper.stdout?.setEncoding("utf-8");
      wrapper.stderr?.setEncoding("utf-8");
      wrapper.stdout?.on("data", (chunk: string) => output.push(chunk));
      wrapper.stderr?.on("data", (chunk: string) => output.push(chunk));

      try {
        await waitFor(
          () =>
            existsSync(socketPath) &&
            readEvents(logPath).some(
              (event) => event.event === "model-list-stalled",
            ),
        );
      } catch (error) {
        throw new Error(
          `${String(error)}\nwrapper output:\n${output.join("")}\nfixture events:\n${
            JSON.stringify(readEvents(logPath), null, 2)
          }`,
        );
      }
      peer = await connectToWrapper(socketPath, ipcAuthToken);
      const messages: WrapperToMcp[] = [];
      peer.on("message", (message: WrapperToMcp) => messages.push(message));
      peer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        messages.some((message) => message.type === "config")
      );

      peer.send({
        type: "clear",
        request_id: "clear-during-startup",
        origin: {
          source: "discord",
          chat_id: "channel-startup",
          message_id: "message-startup",
          user: "operator-startup",
        },
      });
      await waitFor(
        () =>
          readEvents(logPath).filter(
            (event) => event.event === "app-start",
          ).length === 2 &&
          readEvents(logPath).filter(
            (event) =>
              event.event === "request" &&
              event.method === "thread/start",
          ).length === 2,
      );
      expect(wrapper.exitCode).toBeNull();
      expect(wrapper.signalCode).toBeNull();

      // Runtime replacement clears ready peers. A replacement MCP generation
      // announces readiness and flushes the correlated command result.
      peer.send({ type: "ready", source: "discord" });
      await waitFor(() =>
        messages.some(
          (message) =>
            message.type === "command_result" &&
            message.request_id === "clear-during-startup" &&
            message.ok,
        )
      );
      expect(wrapper.exitCode).toBeNull();
      expect(output.join("")).not.toContain(
        "Codex app-server 시작에 실패했습니다",
      );
    },
    15_000,
  );
});
