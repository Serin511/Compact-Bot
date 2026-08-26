import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAppServer,
  buildCodexAppServerArgs,
  formatChannelMessage,
  type CodexQuestion,
  waitForDirectChildExit,
} from "../src/codex-app-server.js";
import {
  COMPACT_BOT_VERSION,
  DISCORD_MCP_SERVER_INFO,
  SLACK_MCP_SERVER_INFO,
} from "../src/version.js";

function writeLifecycleFake(tempDir: string): {
  executable: string;
  logPath: string;
  updatedCwd: string;
} {
  const executable = join(tempDir, "fake-lifecycle-app-server.mjs");
  const logPath = join(tempDir, "lifecycle-requests.jsonl");
  const updatedCwd = join(tempDir, "updated-cwd");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) =>
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(message) + "\\n");
let threadId = "";
let turn = 0;
log({ event: "process/start", pid: process.pid });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "lifecycle-fake" } });
	  } else if (message.method === "thread/start") {
	    threadId = "thr_lifecycle";
	    const requestedModel = message.params.model || "gpt-test";
	    const emptyReasoningModel = requestedModel === "gpt-empty";
	    send({
	      id: message.id,
	      result: {
	        thread: { id: threadId },
	        model: requestedModel,
	        cwd: emptyReasoningModel ? process.env.UPDATED_CWD : message.params.cwd,
	        reasoningEffort: emptyReasoningModel
	          ? null
	          : message.params.config?.model_reasoning_effort || "high"
      }
    });
  } else if (message.method === "model/list") {
    const rows = [
      ["gpt-test", ["low", "high"]],
      ["gpt-rerouted", ["low"]],
      ["gpt-empty", []]
    ];
    send({
      id: message.id,
      result: {
        data: rows.map(([model, efforts]) => ({
          id: model,
          model,
          supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
            reasoningEffort,
            description: reasoningEffort
          }))
        })),
        nextCursor: null
      }
    });
  } else if (message.method === "thread/settings/update") {
    send({ id: message.id, result: {} });
    send({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: { effort: message.params.effort }
      }
    });
  } else if (message.method === "turn/start") {
    const text = message.params.input?.[0]?.text || "";
    const turnId = "turn_" + (++turn);
    const started = {
      method: "turn/started",
      params: {
        threadId,
        turn: { id: turnId, status: "inProgress", items: [] }
      }
    };
    const completed = {
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null }
      }
    };
    if (text === "race") {
      send(started);
      send(completed);
      setTimeout(() => {
        send({ id: message.id, result: { turn: { id: turnId } } });
      }, 20);
      return;
    }

    send({ id: message.id, result: { turn: { id: turnId } } });
    send(started);
    if (text === "resolved") {
      send({
        id: "question_1",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "question_item",
          autoResolutionMs: null,
          questions: [{
            id: "choice",
            header: "선택",
            question: "계속할까요?",
            isOther: false,
            isSecret: false,
            options: [{ label: "예", description: "" }]
          }]
        }
      });
      setTimeout(() => {
        send({
          method: "serverRequest/resolved",
          params: { threadId, requestId: "question_1" }
        });
        send(completed);
      }, 20);
    } else if (text === "reroute") {
      send({
        method: "model/rerouted",
        params: {
          threadId,
          turnId,
          fromModel: "gpt-test",
          toModel: "gpt-rerouted",
          reason: "highRiskCyberActivity"
        }
      });
      send(completed);
	    } else if (text === "settings") {
      send({
        method: "thread/settings/updated",
        params: {
          threadId,
          threadSettings: {
            model: "gpt-empty",
            cwd: process.env.UPDATED_CWD,
            effort: null
          }
        }
	      });
	      send(completed);
	    } else if (text === "numeric-label") {
	      send({
	        id: "question_numeric",
	        method: "item/tool/requestUserInput",
	        params: {
	          threadId,
	          turnId,
	          itemId: "question_numeric_item",
	          autoResolutionMs: null,
	          questions: [{
	            id: "numeric",
	            header: "숫자 라벨",
	            question: "첫 번째 숫자 라벨을 선택하세요",
	            isOther: false,
	            isSecret: false,
	            options: [
	              { label: "2", description: "첫 번째" },
	              { label: "1", description: "두 번째" }
	            ]
	          }]
	        }
	      });
	      setTimeout(() => send(completed), 20);
	    } else {
      send(completed);
    }
  } else if (message.method === "turn/steer") {
    send({ id: message.id, result: {} });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: message.params.turnId,
          status: "interrupted",
          error: null
        }
      }
    });
  } else if (
    message.method === "thread/goal/clear" ||
    message.method === "thread/unsubscribe"
  ) {
    send({ id: message.id, result: {} });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  chmodSync(executable, 0o755);
  return { executable, logPath, updatedCwd };
}

function writeControlBarrierFake(tempDir: string): {
  executable: string;
  logPath: string;
} {
  const executable = join(tempDir, "fake-control-barrier-app-server.mjs");
  const logPath = join(tempDir, "control-barrier-requests.jsonl");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) =>
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(message) + "\\n");
const threadId = "thr_control_barrier";
let turn = 0;
let threadEffort = "high";
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "control-barrier-fake" } });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
        thread: { id: threadId },
        model: "gpt-test",
        cwd: message.params.cwd,
        reasoningEffort: "high"
      }
    });
  } else if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "ultra" }
          ]
        }],
        nextCursor: null
      }
    });
  } else if (message.method === "thread/settings/update") {
    threadEffort = message.params.effort;
    send({ id: message.id, result: {} });
    send({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: { effort: threadEffort }
      }
    });
  } else if (message.method === "turn/start") {
    const turnId = "turn_user_" + (++turn);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } }
    });
    if (message.params.input?.[0]?.text === "after compact") {
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: "after_compact_answer",
            type: "agentMessage",
            phase: "final_answer",
            text: "after compact"
          }
        }
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "completed", error: null }
        }
      });
    }
  } else if (message.method === "turn/steer") {
    if (
      message.params.expectedTurnId === "turn_user_1" &&
      message.params.input?.[0]?.text === "race deferred goal"
    ) {
      send({
        id: message.id,
        error: { code: -32600, message: "turn is no longer active" }
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: "turn_user_1",
            status: "completed",
            error: null
          }
        }
      });
    } else {
      send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    }
  } else if (message.method === "thread/inject_items") {
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    setTimeout(() => {
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn_user_1", status: "interrupted", error: null }
        }
      });
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn_compact", status: "inProgress" }
        }
      });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId: "turn_compact",
          item: { id: "compact_item", type: "contextCompaction" }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn_compact",
          item: { id: "compact_item", type: "contextCompaction" }
        }
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn_compact", status: "completed", error: null }
        }
      });
      log({ event: "compact/completed" });
    }, 25);
  } else if (message.method === "thread/goal/set") {
    if (message.params.objective === "reject replacement") {
      send({
        id: message.id,
        error: { code: -32600, message: "replacement rejected" }
      });
      return;
    }
    if (
      message.params.objective === "complete before response" ||
      message.params.objective === "completed before response"
    ) {
      const status = message.params.objective.startsWith("completed")
        ? "completed"
        : "complete";
      send({
        method: "thread/goal/updated",
        params: {
          threadId,
          goal: {
            objective: message.params.objective,
            status
          }
        }
      });
      send({
        id: message.id,
        result: {
          goal: {
            threadId,
            objective: message.params.objective,
            status
          }
        }
      });
      return;
    }
    send({
      id: message.id,
      result: {
        goal: {
          threadId,
          objective: message.params.objective,
          status: "active"
        }
      }
    });
    if (
      message.params.objective === "fail before start" ||
      message.params.objective === "pause before start"
    ) {
      const status = message.params.objective === "pause before start"
        ? "paused"
        : "failed";
      send({
        method: "thread/goal/updated",
        params: {
          threadId,
          turnId: null,
          goal: {
            objective: message.params.objective,
            status
          }
        }
      });
      return;
    }
    if (message.params.objective === "goal while active") {
      // A delayed duplicate notification for the pre-goal turn must not open
      // the barrier. Only the distinct automatic goal turn may do so.
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn_user_1", status: "inProgress" }
        }
      });
      setTimeout(() => {
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: "turn_user_1",
              status: "completed",
              error: null
            }
          }
        });
      }, 40);
      setTimeout(() => {
        send({
          method: "turn/started",
          params: {
            threadId,
            turn: { id: "turn_goal_active", status: "inProgress" }
          }
        });
        log({ event: "goal/started-after-active", effort: threadEffort });
      }, 100);
      return;
    }
    // A delayed start for an already-completed turn must not satisfy the
    // first-automatic-goal-turn barrier.
    send({
      method: "turn/started",
      params: {
        threadId,
        turn: { id: "turn_user_2", status: "inProgress" }
      }
    });
    setTimeout(() => {
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn_goal", status: "inProgress" }
        }
      });
      log({ event: "goal/started", effort: threadEffort });
    }, 25);
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: message.params.turnId,
          status: "interrupted",
          error: null
        }
      }
    });
  } else if (
    message.method === "thread/goal/clear" ||
    message.method === "thread/unsubscribe"
  ) {
    send({ id: message.id, result: {} });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  chmodSync(executable, 0o755);
  return { executable, logPath };
}

function writeStalledControlFake(tempDir: string): {
  executable: string;
  logPath: string;
} {
  const executable = join(tempDir, "fake-stalled-control-app-server.mjs");
  const logPath = join(tempDir, "stalled-control-requests.jsonl");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) =>
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
    ...message,
    owner: process.pid
  }) + "\\n");
const threadId = "thr_stalled_" + process.pid;
let turn = 0;
log({ event: "app-start" });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log({ event: "request", method: message.method, params: message.params });
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "stalled-control-fake" } });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
        thread: { id: threadId },
        model: "gpt-test",
        cwd: message.params.cwd,
        reasoningEffort: "high"
      }
    });
  } else if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }]
        }],
        nextCursor: null
      }
    });
  } else if (message.method === "turn/start") {
    const turnId = "turn_" + process.pid + "_" + (++turn);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } }
    });
    if (message.params.input?.[0]?.text === "question pending") {
      send({
        id: "pending_question",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "pending_question_item",
          autoResolutionMs: null,
          questions: [{
            id: "choice",
            header: "pending",
            question: "wait forever",
            isOther: false,
            isSecret: false,
            options: [{ label: "continue", description: "" }]
          }]
        }
      });
    }
  } else if (message.method === "thread/compact/start") {
    // Acknowledge scheduling but deliberately omit the compaction lifecycle.
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/goal/set") {
    send({
      id: message.id,
      result: {
        goal: {
          threadId,
          objective: message.params.objective,
          status: "active"
        }
      }
    });
    send({
      method: "thread/goal/updated",
      params: {
        threadId,
        goal: { objective: message.params.objective, status: "active" }
      }
    });
    // Deliberately omit the first automatic goal turn.
  } else if (message.method === "thread/goal/clear") {
    send({ id: message.id, result: {} });
    send({ method: "thread/goal/cleared", params: { threadId } });
  } else if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: message.params.turnId,
          status: "interrupted",
          error: null
        }
      }
    });
  } else if (message.method === "thread/unsubscribe") {
    send({ id: message.id, result: {} });
  }
});
process.on("SIGTERM", () => {
  log({ event: "process/exit" });
  process.exit(0);
});
`,
  );
  chmodSync(executable, 0o755);
  return { executable, logPath };
}

function writeCaptureFailureFake(tempDir: string): {
  executable: string;
  logPath: string;
} {
  const executable = join(tempDir, "fake-capture-failure-app-server.mjs");
  const logPath = join(tempDir, "capture-failure-requests.jsonl");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const log = (message) =>
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(message) + "\\n");
const mode = process.env.CAPTURE_FAILURE_MODE;
const threadId = "thr_capture_failure";
let turn = 0;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "capture-failure-fake" } });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
        thread: { id: threadId },
        model: "gpt-test",
        cwd: message.params.cwd,
        reasoningEffort: "high"
      }
    });
  } else if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          supportedReasoningEfforts: [
            { reasoningEffort: "high" },
            { reasoningEffort: "ultra" }
          ]
        }],
        nextCursor: null
      }
    });
  } else if (message.method === "turn/start") {
    const turnId = "turn_capture_" + (++turn);
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } }
    });
    if (mode === "method-not-found") {
      for (let warning = 0; warning < 10; warning += 1) {
        send({
          method: "warning",
          params: {
            threadId,
            message:
              "large-warning-" + warning + "-" + "w".repeat(100000)
          }
        });
      }
      send({
        method: "error",
        params: { threadId, message: "large-error-" + "e".repeat(700000) }
      });
    }
    send({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "fallback_answer_" + turn,
          type: "agentMessage",
          text: "fallback answer"
        }
      }
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", error: null }
      }
    });
  } else if (message.method === "thread/turns/list") {
    if (mode === "method-not-found") {
      send({
        id: message.id,
        error: { code: -32601, message: "Method not found" }
      });
    } else {
      process.stdout.write(
        '{"id":' + JSON.stringify(message.id) +
        ',"result":{"data":[{"id":"turn_huge","status":"completed","items":[{"type":"agentMessage","text":"'
      );
      process.stdout.write("x".repeat(16 * 1024 * 1024 + 1024));
      process.stdout.write('"}]}],"nextCursor":null}}\\n');
      send({
        method: "warning",
        params: { threadId, message: "protocol recovered" }
      });
    }
  } else if (message.method === "thread/settings/update") {
    send({ id: message.id, result: {} });
    send({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: { effort: message.params.effort }
      }
    });
  } else if (
    message.method === "thread/goal/clear" ||
    message.method === "thread/unsubscribe"
  ) {
    send({ id: message.id, result: {} });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
  chmodSync(executable, 0o755);
  return { executable, logPath };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Codex test state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Codex app-server helpers", () => {
  it("keeps runtime protocol versions aligned with package.json", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version: string };

    expect(COMPACT_BOT_VERSION).toBe(packageJson.version);
    expect(DISCORD_MCP_SERVER_INFO).toEqual({
      name: "discord-bot",
      version: packageJson.version,
    });
    expect(SLACK_MCP_SERVER_INFO).toEqual({
      name: "slack-bot",
      version: packageJson.version,
    });
  });

  it("builds MCP overrides without embedding token values", () => {
    const args = buildCodexAppServerArgs([
      {
        name: "compact_bot_discord",
        command: "node",
        args: ["/pkg/claude-mcp-proxy.js", "discord", "/data/mcp.sock"],
        envVars: [],
      },
    ]);
    const rendered = args.join(" ");

    expect(args[0]).toBe("app-server");
    expect(rendered).toContain('mcp_servers.compact_bot_discord.command="node"');
    expect(rendered).toContain(
      "shell_environment_policy.ignore_default_excludes=false",
    );
    expect(rendered).toContain(
      "mcp_servers.compact_bot_discord.env_vars=[]",
    );
    expect(rendered).toContain(
      'mcp_servers.compact_bot_discord.args=["/pkg/claude-mcp-proxy.js","discord","/data/mcp.sock"]',
    );
    expect(rendered).toContain(
      'mcp_servers.compact_bot_discord.default_tools_approval_mode="approve"',
    );
    expect(rendered).not.toContain("secret-token-value");
    expect(rendered).not.toContain("DISCORD_BOT_TOKEN");
    expect(rendered).not.toContain("COMPACT_BOT_IPC_AUTH_TOKEN");
  });

  it("formats a channel envelope and escapes metadata attributes", () => {
    expect(
      formatChannelMessage("slack", "안녕하세요", {
        chat_id: 'C123"bad',
        user: "A&B",
        thread_ts: "123.4",
      }),
    ).toBe(
      '<channel source="slack" chat_id="C123&quot;bad" user="A&amp;B" thread_ts="123.4">\n' +
      "안녕하세요\n" +
      "</channel>",
    );
  });

  it("reports a direct child that exits during graceful termination", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
    const terminate = vi.fn((signal: NodeJS.Signals) => {
      if (signal === "SIGTERM") queueMicrotask(() => child.emit("exit"));
    });

    await expect(
      waitForDirectChildExit(child, terminate, 10),
    ).resolves.toBe(true);
    expect(terminate).toHaveBeenCalledWith("SIGTERM");
    expect(terminate).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("fences a direct child when forced termination never emits exit", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
      });
      const terminate = vi.fn();
      const waiting = waitForDirectChildExit(child, terminate, 50);

      await vi.advanceTimersByTimeAsync(1_050);
      await expect(waiting).resolves.toBe(false);
      expect(terminate.mock.calls.map(([signal]) => signal)).toEqual([
        "SIGTERM",
        "SIGKILL",
        "SIGKILL",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodexAppServer protocol", () => {
  let backend: CodexAppServer | null = null;
  let tempDir = "";

  afterEach(async () => {
    await backend?.stop();
    backend = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  });

  it("uses canonical thread cwd and preserves an explicit null effort", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-start-state-"));
    const { executable, logPath, updatedCwd } = writeLifecycleFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-empty",
      effort: "ultra",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        UPDATED_CWD: updatedCwd,
      },
      onQuestion: async () => null,
    });

    await backend.start();

    expect(backend.currentModel).toBe("gpt-empty");
    expect(backend.currentCwd).toBe(updatedCwd);
    expect(backend.currentEffort).toBe("");
    expect(backend.availableEfforts).toEqual([]);
  });

  it("falls back to bounded notification history when turns/list is unavailable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-capture-fallback-"));
    const { executable, logPath } = writeCaptureFailureFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        CAPTURE_FAILURE_MODE: "method-not-found",
      },
      onQuestion: async () => null,
    });

    await backend.start();
    await backend.submitText("populate fallback");
    await waitFor(() => backend?.currentTurnId === null);
    const capture = await backend.captureStatus(true);

    expect(capture).toContain(
      "(transcript unavailable; showing bounded notification history)",
    );
    expect(capture).toContain("fallback answer");
    expect(capture).toContain("warning: large-warning-");
    expect(capture).toContain("error: large-error-");
    expect(capture).toContain("event content truncated");
    expect(capture.length).toBeLessThan(530_000);
    const recentEvents = (
      backend as unknown as { recentEvents: string[] }
    ).recentEvents;
    expect(recentEvents.every((event) => event.length <= 64 * 1024)).toBe(true);
    expect(recentEvents.join("\n").length).toBeLessThanOrEqual(512 * 1024);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.filter((message) => message.method === "thread/turns/list"),
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.method === "thread/read"),
    ).toHaveLength(0);
  });

  it("discards an oversized response and keeps the protocol usable", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-large-jsonl-"));
    const { executable, logPath } = writeCaptureFailureFake(tempDir);
    const errors: string[] = [];
    const exits: unknown[] = [];
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        CAPTURE_FAILURE_MODE: "oversized",
      },
      onQuestion: async () => null,
      onError: (message, error) => {
        errors.push(`${message}: ${String(error)}`);
      },
    });
    backend.on("exit", (event) => exits.push(event));

    await backend.start();
    await backend.submitText("populate oversized fallback");
    await waitFor(() => backend?.currentTurnId === null);
    const capture = await backend.captureStatus(true);

    expect(capture).toContain(
      "(transcript unavailable; showing bounded notification history)",
    );
    expect(capture).toContain("fallback answer");
    expect(capture.length).toBeLessThan(530_000);
    expect(errors.some((message) =>
      message.includes("protocol line was too large")
    )).toBe(true);

    await backend.setEffort("ultra");
    expect(backend.currentEffort).toBe("ultra");
    expect(exits).toHaveLength(0);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.filter((message) => message.method === "thread/turns/list"),
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.method === "thread/read"),
    ).toHaveLength(0);
    expect(
      messages.filter((message) => message.method === "thread/settings/update"),
    ).toHaveLength(1);
  });

  it("does not resurrect a turn completed before turn/start returns", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-race-"));
    const { executable, logPath, updatedCwd } = writeLifecycleFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        UPDATED_CWD: updatedCwd,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    const raced = await backend.submitText("race");
    expect(raced).toEqual({ turnId: "turn_1", steered: false });
    expect(backend.currentTurnId).toBeNull();

    const following = await backend.submitText("after-race");
    expect(following).toEqual({ turnId: "turn_2", steered: false });
    await waitFor(() => backend?.currentTurnId === null);
    expect(backend.currentTurnId).toBeNull();

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.find((message) => message.method === "initialize")
        .params.clientInfo.version,
    ).toBe(COMPACT_BOT_VERSION);
    expect(
      messages.filter((message) => message.method === "turn/start"),
    ).toHaveLength(2);
    expect(
      messages.filter((message) => message.method === "turn/steer"),
    ).toHaveLength(0);
  });

  it("holds later input behind compact completion and idle goal startup", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-barriers-"));
    const { executable, logPath } = writeControlBarrierFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    await backend.submitText("long running");

    const compacting = backend.compact("keep the marker");
    const afterCompaction = backend.submitText("after compact");
    await compacting;
    expect(await afterCompaction).toEqual({
      turnId: "turn_user_2",
      steered: false,
    });
    await waitFor(() => backend?.currentTurnId === null);
    expect(backend.currentTurnId).toBeNull();

    await backend.setEffort("ultra");
    const settingGoal = backend.setGoal("keep working");
    const afterGoal = backend.submitText("after goal");
    await settingGoal;
    expect(await afterGoal).toEqual({
      turnId: "turn_goal",
      steered: true,
    });
    expect(backend.currentTurnId).toBe("turn_goal");
    let rejectedReplacementAccepted = false;
    await expect(
      backend.setGoal(
        "reject replacement",
        undefined,
        undefined,
        () => {
          rejectedReplacementAccepted = true;
        },
      ),
    ).rejects.toThrow("replacement rejected");
    expect(rejectedReplacementAccepted).toBe(false);
    expect(backend.hasActiveGoal).toBe(true);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const compactCompleted = messages.findIndex(
      (message) => message.event === "compact/completed",
    );
    const postCompactStart = messages.findIndex(
      (message) =>
        message.method === "turn/start" &&
        message.params.input?.[0]?.text === "after compact",
    );
    const goalStarted = messages.findIndex(
      (message) => message.event === "goal/started",
    );
    const effortUpdated = messages.findIndex(
      (message) => message.method === "thread/settings/update",
    );
    const goalSet = messages.findIndex(
      (message) => message.method === "thread/goal/set",
    );
    const postGoalSteer = messages.findIndex(
      (message) =>
        message.method === "turn/steer" &&
        message.params.input?.[0]?.text === "after goal",
    );

    expect(compactCompleted).toBeGreaterThanOrEqual(0);
    expect(postCompactStart).toBeGreaterThan(compactCompleted);
    expect(effortUpdated).toBeGreaterThan(postCompactStart);
    expect(goalSet).toBeGreaterThan(effortUpdated);
    expect(goalStarted).toBeGreaterThanOrEqual(0);
    expect(postGoalSteer).toBeGreaterThan(goalStarted);
    expect(messages[goalStarted]).toMatchObject({
      event: "goal/started",
      effort: "ultra",
    });
    expect(backend.currentEffort).toBe("ultra");
  });

  it("waits for a distinct goal turn when a pre-goal turn is active", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-active-goal-"));
    const { executable, logPath } = writeControlBarrierFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    await backend.submitText("active before goal");
    expect(backend.currentTurnId).toBe("turn_user_1");
    let accepted = false;
    let settled = false;
    const settingGoal = backend.setGoal(
      "goal while active",
      undefined,
      undefined,
      () => {
        accepted = true;
      },
    ).then(() => {
      settled = true;
    });

    await waitFor(() => accepted);
    await settingGoal;
    expect(settled).toBe(true);
    expect(backend.currentTurnId).toBe("turn_user_1");
    expect(
      readFileSync(logPath, "utf-8").includes(
        '"event":"goal/started-after-active"',
      ),
    ).toBe(false);
    await expect(backend.compact()).rejects.toThrow(
      "활성 Codex goal",
    );
    expect(
      readFileSync(logPath, "utf-8").includes(
        '"method":"thread/compact/start"',
      ),
    ).toBe(false);

    let postGoalSettled = false;
    const postGoalInput = backend.submitText("race deferred goal").then(
      (result) => {
        postGoalSettled = true;
        return result;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postGoalSettled).toBe(false);
    await expect(postGoalInput).resolves.toEqual({
      turnId: "turn_goal_active",
      steered: true,
    });
    expect(backend.currentTurnId).toBe("turn_goal_active");
    expect(
      readFileSync(logPath, "utf-8").includes(
        '"event":"goal/started-after-active"',
      ),
    ).toBe(true);
  });

  it.each(["complete", "completed"])(
    "does not resurrect a goal with %s before goal/set responds",
    async (status) => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-goal-revision-"));
    const { executable, logPath } = writeControlBarrierFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    let accepted = false;
    await backend.setGoal(
      `${status} before response`,
      undefined,
      undefined,
      () => {
        accepted = true;
      },
    );
    expect(accepted).toBe(false);
    expect(backend.hasActiveGoal).toBe(false);
    },
  );

  it("lets interrupt bypass a stalled compaction lifecycle", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-control-esc-"));
    const { executable, logPath } = writeStalledControlFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    const firstThreadId = backend.currentThreadId;
    await backend.submitText("active before compact");
    const compactOutcome = backend.compact().then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() =>
      readFileSync(logPath, "utf-8").includes('"method":"thread/compact/start"')
    );
    const queuedAfterCompact = backend.submitText("queued after interrupt");

    const startedAt = Date.now();
    await backend.interrupt();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await compactOutcome).toBeInstanceOf(Error);
    await expect(queuedAfterCompact).rejects.toThrow(
      "session changed",
    );
    expect(backend.currentThreadId).not.toBe(firstThreadId);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.filter((message) => message.event === "app-start"),
    ).toHaveLength(2);
    expect(
      messages.some(
        (message) =>
          message.method === "turn/start" &&
          message.params.input?.[0]?.text === "queued after interrupt",
      ),
    ).toBe(false);

    const firstOwner = messages.find(
      (message) => message.event === "app-start",
    )?.owner;
    const oldMessages = messages.filter(
      (message) => message.owner === firstOwner,
    );
    const interruptIndex = oldMessages.findIndex(
      (message) => message.method === "turn/interrupt",
    );
    const exitIndex = oldMessages.findIndex(
      (message) => message.event === "process/exit",
    );
    expect(interruptIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBeGreaterThan(interruptIndex);
  });

  it("keeps a normal interrupt on the live runtime when no mutation is uncertain", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-control-plain-esc-"));
    const { executable, logPath } = writeStalledControlFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    const threadId = backend.currentThreadId;
    await backend.submitText("ordinary active turn");
    await backend.interrupt();
    expect(backend.currentThreadId).toBe(threadId);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.filter((message) => message.event === "app-start"),
    ).toHaveLength(1);
    expect(
      messages.filter((message) => message.method === "turn/interrupt"),
    ).toHaveLength(1);
  });

  it("replaces the runtime when interrupting an unresolved server request", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-control-question-"));
    const { executable, logPath } = writeStalledControlFake(tempDir);
    let questionReceived = false;
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => {
        questionReceived = true;
        return await new Promise<string | null>(() => {});
      },
    });

    await backend.start();
    const firstThreadId = backend.currentThreadId;
    await backend.submitText("question pending");
    await waitFor(() => questionReceived);
    await backend.interrupt();
    expect(backend.currentThreadId).not.toBe(firstThreadId);
    expect(
      readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((line) => line.includes('"event":"app-start"')),
    ).toHaveLength(2);
  });

  it("restarts before a stalled compaction timeout and drops old queued work", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-control-new-"));
    const { executable, logPath } = writeStalledControlFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    const firstThreadId = backend.currentThreadId;
    await backend.submitText("active before restart");
    const compactOutcome = backend.compact().then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() =>
      readFileSync(logPath, "utf-8").includes('"method":"thread/compact/start"')
    );
    const oldQueuedOutcome = backend.submitText("must not cross sessions").then(
      () => null,
      (error: unknown) => error,
    );

    const startedAt = Date.now();
    await backend.newSession();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await compactOutcome).toBeInstanceOf(Error);
    expect(await oldQueuedOutcome).toMatchObject({
      message: expect.stringContaining("session changed"),
    });
    expect(backend.currentThreadId).not.toBe(firstThreadId);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.filter((message) => message.event === "app-start"),
    ).toHaveLength(2);
    expect(
      messages.some(
        (message) =>
          message.method === "turn/start" &&
          message.params.input?.[0]?.text === "must not cross sessions",
      ),
    ).toBe(false);
  });

  it("lets goal clear bypass a stalled first-goal-turn barrier", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-control-goal-"));
    const { executable, logPath } = writeStalledControlFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    const goalOutcome = backend.setGoal("stalled objective").then(
      () => null,
      (error: unknown) => error,
    );
    await waitFor(() =>
      readFileSync(logPath, "utf-8").includes('"method":"thread/goal/set"')
    );

    const startedAt = Date.now();
    await backend.setGoal("clear");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(await goalOutcome).toBeInstanceOf(Error);
    expect(backend.hasActiveGoal).toBe(false);

    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.filter((message) => message.method === "thread/goal/clear"),
    ).toHaveLength(1);
  });

  it("rolls back a goal accepted without a viable first automatic turn", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-goal-rollback-"));
    const { executable, logPath } = writeControlBarrierFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async () => null,
    });

    await backend.start();
    await backend.setGoal("pause before start");
    expect(backend.hasActiveGoal).toBe(true);
    await backend.setGoal("clear");
    expect(backend.hasActiveGoal).toBe(false);

    let accepted = false;
    await expect(
      backend.setGoal(
        "fail before start",
        undefined,
        undefined,
        () => {
          accepted = true;
        },
      ),
    ).rejects.toThrow(
      "Codex goal failed before its first automatic turn",
    );

    expect(accepted).toBe(true);
    expect(backend.hasActiveGoal).toBe(false);
    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const setIndex = messages.findIndex(
      (message) =>
        message.method === "thread/goal/set" &&
        message.params.objective === "fail before start",
    );
    const clearIndex = messages.findIndex(
      (message, index) =>
        index > setIndex && message.method === "thread/goal/clear",
    );
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(setIndex);
  });

  it("aborts a pending question when app-server resolves the request", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-resolved-"));
    const { executable, logPath, updatedCwd } = writeLifecycleFake(tempDir);
    let receivedQuestion: CodexQuestion | null = null;
    let signalAborted = false;
    const resolvedEvents: Array<Record<string, unknown>> = [];
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        UPDATED_CWD: updatedCwd,
      },
      onQuestion: async (question) => {
        receivedQuestion = question;
        question.signal?.addEventListener(
          "abort",
          () => {
            signalAborted = true;
          },
          { once: true },
        );
        return await new Promise<string | null>(() => {});
      },
    });
    backend.on("serverRequestResolved", (event) => {
      resolvedEvents.push(event as Record<string, unknown>);
    });

    await backend.start();
    await backend.submitText("resolved");
    await waitFor(() => signalAborted);

    expect(receivedQuestion).toMatchObject({
      requestId: "question_1",
      threadId: "thr_lifecycle",
      turnId: "turn_1",
      itemId: "question_item",
    });
    expect(receivedQuestion?.signal?.aborted).toBe(true);
    expect(resolvedEvents).toEqual([{
      requestId: "question_1",
      threadId: "thr_lifecycle",
      method: "item/tool/requestUserInput",
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages.some(
        (message) => message.id === "question_1" && !message.method,
      ),
    ).toBe(false);
  });

  it("prefers an exact numeric option label over interpreting it again as an index", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-numeric-label-"));
    const { executable, logPath, updatedCwd } = writeLifecycleFake(tempDir);
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        UPDATED_CWD: updatedCwd,
      },
      // Chat adapters resolve a button index to its label before returning it.
      onQuestion: async (question) => question.options[0]?.label ?? null,
    });

    await backend.start();
    await backend.submitText("numeric-label");
    await waitFor(() => {
      const messages = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return messages.some(
        (message) =>
          message.id === "question_numeric" &&
          message.result?.answers?.numeric?.answers?.[0] === "2",
      );
    });

    const answer = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((message) => message.id === "question_numeric" && message.result);
    expect(answer.result).toEqual({
      answers: { numeric: { answers: ["2"] } },
    });
  });

  it("keeps turn reroutes non-sticky and synchronizes updated thread settings", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-settings-"));
    const { executable, logPath, updatedCwd } = writeLifecycleFake(tempDir);
    const stateEvents: Array<Record<string, unknown>> = [];
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
        UPDATED_CWD: updatedCwd,
      },
      onQuestion: async () => null,
    });
    backend.on("state", (state) => {
      stateEvents.push(state as Record<string, unknown>);
    });

    await backend.start();
    expect(backend.availableEfforts).toEqual(["low", "high"]);

    await backend.submitText("reroute");
    await waitFor(() => backend?.currentTurnId === null);
    expect(backend.currentModel).toBe("gpt-test");
    expect(backend.currentEffort).toBe("high");
    expect(backend.availableEfforts).toEqual(["low", "high"]);

    await backend.submitText("settings");
    await waitFor(
      () =>
        backend?.currentModel === "gpt-empty" &&
        backend.currentCwd === updatedCwd,
    );
    expect(backend.currentModel).toBe("gpt-empty");
    expect(backend.currentCwd).toBe(updatedCwd);
    expect(backend.currentEffort).toBe("");
    expect(backend.availableEfforts).toEqual([]);
    await expect(backend.setEffort("low")).rejects.toThrow(
      "gpt-empty은 low effort를 지원하지 않습니다",
    );
    expect(backend.effortForModel("gpt-empty", "ultra")).toBe("");
    expect(backend.effortForModel("unknown-model", "ultra")).toBe("ultra");

    await waitFor(() => {
      const messages = readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return messages.filter((message) => message.method === "model/list")
        .length >= 2;
    });
    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const turnStarts = messages.filter(
      (message) => message.method === "turn/start",
    );
    expect(turnStarts[1].params).toMatchObject({
      model: "gpt-test",
      effort: "high",
    });
    expect(stateEvents).not.toContainEqual(expect.objectContaining({
      model: "gpt-rerouted",
    }));
    expect(stateEvents).toContainEqual(expect.objectContaining({
      model: "gpt-empty",
      effort: "",
      cwd: updatedCwd,
      availableEfforts: [],
    }));
  });

  it("initializes, starts a thread, submits a turn, and answers user input", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compact-bot-codex-test-"));
    const executable = join(tempDir, "fake-app-server.mjs");
    const logPath = join(tempDir, "requests.jsonl");
    writeFileSync(
      executable,
      `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const log = (msg) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(msg) + "\\n");
log({ event: "process/start", pid: process.pid });
let thread = 0;
let turn = 0;
let threadId = "";
let failCleanup = false;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "fake" } });
  } else if (msg.method === "thread/start") {
    thread += 1;
    threadId = "thr_" + process.pid + "_" + thread;
    send({
      id: msg.id,
      result: {
        thread: { id: threadId },
        model: msg.params.model || "gpt-test",
        reasoningEffort:
          msg.params.config?.model_reasoning_effort || "medium"
      }
    });
  } else if (msg.method === "model/list") {
    const page = msg.params.cursor === "page_2"
      ? [["gpt-next", ["low", "medium", "high"]]]
      : [["gpt-test", ["low", "high", "ultra"]]];
    send({
      id: msg.id,
      result: {
        data: page.map(([model, efforts]) => ({
          id: model,
          model,
          supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
            reasoningEffort,
            description: reasoningEffort
          }))
        })),
        nextCursor: msg.params.cursor === "page_2" ? null : "page_2"
      }
    });
  } else if (msg.method === "thread/settings/update") {
    send({ id: msg.id, result: {} });
    send({
      method: "thread/settings/updated",
      params: {
        threadId,
        threadSettings: { effort: msg.params.effort }
      }
    });
  } else if (msg.method === "turn/start") {
    turn += 1;
    if (msg.params.input?.[0]?.text === "closeSession cleanup") {
      failCleanup = true;
    }
    const turnId = "turn_" + turn;
    send({ id: msg.id, result: { turn: { id: turnId } } });
    if (turn === 1) {
      send({
        id: "ask_1",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "item_1",
          autoResolutionMs: null,
          questions: [{
            id: "scope",
            header: "범위",
            question: "어디까지 할까요?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "최소", description: "핵심만" },
              { label: "전체", description: "모두" }
            ]
          }]
        }
      });
      send({
        id: "ask_foreign",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thr_foreign",
          turnId: "turn_foreign",
          itemId: "item_foreign",
          questions: [{
            id: "foreign",
            header: "foreign",
            question: "must not be shown",
            isOther: true,
            isSecret: false,
            options: [{ label: "yes", description: "" }]
          }]
        }
      });
      send({
        id: "ask_secret",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "item_secret",
          questions: [{
            id: "secret",
            header: "secret",
            question: "password?",
            isOther: true,
            isSecret: true,
            options: null
          }]
        }
      });
      send({
        id: "ask_freeform_cancel",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "item_freeform",
          autoResolutionMs: null,
          questions: [{
            id: "freeform",
            header: "자유 입력",
            question: "자유 형식으로 답하세요",
            isOther: false,
            isSecret: false,
            options: null
          }]
        }
      });
      send({
        id: "ask_deadline",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "item_deadline",
          autoResolutionMs: 500,
          questions: [
            {
              id: "empty",
              header: "마감 1",
              question: "빈 답변",
              isOther: false,
              isSecret: false,
              options: [{ label: "A", description: "" }]
            },
            {
              id: "later",
              header: "마감 2",
              question: "두 번째 답변",
              isOther: false,
              isSecret: false,
              options: [{ label: "B", description: "" }]
            }
          ]
        }
      });
      send({
        id: "ask_expired",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "item_expired",
          autoResolutionMs: 20,
          questions: [{
            id: "late",
            header: "마감 초과",
            question: "늦은 답변",
            isOther: false,
            isSecret: false,
            options: [{ label: "허용", description: "" }]
          }]
        }
      });
      send({
        id: "approve_command",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "command_approval",
          command: "npm test",
          cwd: "/workspace",
          reason: "테스트 실행",
          commandActions: [{ type: "read", path: "package.json" }],
          networkApprovalContext: { host: "registry.npmjs.org" },
          additionalPermissions: { network: { enabled: true } },
          proposedExecpolicyAmendment: { command_prefix: ["npm", "test"] },
          proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org" }],
          availableDecisions: [
            {
              acceptWithExecpolicyAmendment: {
                execpolicy_amendment: { command_prefix: ["npm", "test"] }
              }
            },
            "decline"
          ]
        }
      });
      send({
        id: "approve_command_empty",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "command_approval_empty",
          command: "echo blocked",
          availableDecisions: []
        }
      });
      send({
        id: "approve_file",
        method: "item/fileChange/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "file_approval",
          reason: "파일 변경 허용",
          grantRoot: "/workspace"
        }
      });
      send({
        id: "approve_permissions",
        method: "item/permissions/requestApproval",
        params: {
          threadId,
          turnId,
          itemId: "permissions_approval",
          reason: "추가 권한",
          cwd: "/workspace",
          environmentId: "local",
          permissions: {
            network: { enabled: true },
            fileSystem: { read: ["/workspace"] }
          }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId: "thr_foreign",
          turnId: "turn_foreign",
          item: { id: "foreign_item", type: "agentMessage", text: "foreign" }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            id: "current_item",
            type: "agentMessage",
            text: "current-" + "x".repeat(600000)
          }
        }
      });
      setTimeout(() => {
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed", error: null }
          }
        });
      }, 100);
    } else if (turn === 3) {
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: turnId, status: "inProgress" }
        }
      });
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          itemId: "live_agent",
          delta: "실시간 답변"
        }
      });
      send({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId,
          turnId,
          itemId: "live_command",
          delta: "실시간 명령 출력"
        }
      });
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn_2", status: "inProgress" }
        }
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn_2", status: "completed", error: null }
        }
      });
    }
  } else if (msg.method === "turn/steer") {
    if (msg.params.input?.[0]?.text === "성공 steer") {
      send({ id: msg.id, result: {} });
    } else {
      send({
        id: msg.id,
        error: { code: -32000, message: "expected turn is not active" }
      });
    }
  } else if (msg.method === "thread/turns/list") {
    const lines = Array.from({ length: 60 }, (_, index) => "line-" + index).join("\\n");
    if (msg.params.cursor === "page_2") {
      send({
        id: msg.id,
        result: {
          data: [{
            id: "turn_capture_older",
            status: "completed",
            error: null,
            items: [
              {
                id: "user_capture",
                type: "userMessage",
                content: [{ type: "text", text: lines }]
              }
            ]
          }],
          // Deliberately repeat the cursor to prove clients do not loop.
          nextCursor: "page_2"
        }
      });
    } else {
      send({
        id: msg.id,
        result: {
          data: [{
            id: "turn_capture_newest",
            status: "completed",
            error: null,
            items: [
              {
                id: "assistant_capture",
                type: "agentMessage",
                text: "capture answer"
              },
              {
                id: "command_capture",
                type: "commandExecution",
                command: "npm test",
                status: "completed",
                aggregatedOutput: "all tests passed",
                exitCode: 0
              },
              {
                id: "mcp_capture",
                type: "mcpToolCall",
                server: "compact_bot",
                tool: "reply",
                status: "completed",
                arguments: { chat_id: "C1" },
                result: { content: [{ type: "text", text: "sent" }] },
                error: null
              }
            ]
          }],
          nextCursor: "page_2"
        }
      });
    }
  } else if (msg.method === "thread/unsubscribe") {
    if (failCleanup) {
      send({ id: msg.id, error: { code: -32000, message: "cleanup failed" } });
    } else {
      send({ id: msg.id, result: { status: "unsubscribed" } });
    }
  } else if (msg.method === "thread/goal/clear") {
    if (failCleanup) {
      send({ id: msg.id, error: { code: -32000, message: "cleanup failed" } });
    } else {
      send({ id: msg.id, result: { cleared: true } });
    }
  } else if (msg.method === "turn/interrupt") {
    if (failCleanup) {
      send({ id: msg.id, error: { code: -32000, message: "cleanup failed" } });
    } else {
      send({ id: msg.id, result: {} });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: msg.params.turnId,
            status: "interrupted",
            error: null
          }
        }
      });
    }
  } else if (msg.method === "thread/compact/start") {
    send({ id: msg.id, result: {} });
    setTimeout(() => {
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn_3", status: "interrupted", error: null }
        }
      });
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn_compact", status: "inProgress" }
        }
      });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId: "turn_compact",
          item: { id: "compact_item", type: "contextCompaction" }
        }
      });
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId: "turn_compact",
          item: { id: "compact_item", type: "contextCompaction" }
        }
      });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: "turn_compact", status: "completed", error: null }
        }
      });
    }, 10);
  } else if (msg.method === "thread/goal/set") {
    send({
      id: msg.id,
      result: {
        goal: {
          threadId,
          objective: msg.params.objective,
          status: "active"
        }
      }
    });
    setTimeout(() => {
      send({
        method: "turn/started",
        params: {
          threadId,
          turn: { id: "turn_goal", status: "inProgress" }
        }
      });
    }, 10);
  } else if (msg.method === "thread/inject_items") {
    send({ id: msg.id, result: {} });
  }
});
process.on("SIGTERM", () => {
  log({ event: "process/exit", pid: process.pid });
  process.exit(0);
});
`,
    );
    chmodSync(executable, 0o755);

    const questions: Array<Record<string, unknown>> = [];
    const notifications: Array<{
      method: string;
      params: Record<string, unknown>;
    }> = [];
    backend = new CodexAppServer({
      executable,
      cwd: tempDir,
      model: "gpt-test",
      effort: "high",
      dangerouslySkipPermissions: false,
      developerInstructions: "Use the reply tool.",
      mcpServers: [],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] =>
            entry[1] !== undefined
          ),
        ),
        FAKE_CODEX_LOG: logPath,
      },
      onQuestion: async (question) => {
        questions.push(question as unknown as Record<string, unknown>);
        if (question.header === "자유 입력") return null;
        if (question.header === "마감 1") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return "";
        }
        if (question.header === "마감 2") return "1";
        if (question.header === "마감 초과") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return "1";
        }
        if (question.question.includes("npm test")) return "1";
        if (question.question.includes("echo blocked")) return "1";
        if (question.question.includes("파일 변경 허용")) return "1";
        if (question.question.includes("추가 권한")) return "2";
        return "2";
      },
    });
    backend.on("notification", (notification) => {
      notifications.push(notification);
    });

    await backend.start();
    const firstThreadId = backend.currentThreadId;
    expect(firstThreadId).toMatch(/^thr_\d+_1$/);

    const firstSubmission = await backend.submitChannelMessage("discord", "테스트", {
      chat_id: "C1",
      message_id: "M1",
    });
    expect(firstSubmission).toEqual({ turnId: "turn_1", steered: false });
    const steeredSubmission = await backend.submitText("성공 steer");
    expect(steeredSubmission).toEqual({ turnId: "turn_1", steered: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(backend.currentTurnId).toBeNull();
    const captureAll = await backend.captureStatus(true);
    const captureViewport = await backend.captureStatus(false);
    await expect(backend.setEffort("minimal")).rejects.toThrow(
      "gpt-test은 minimal effort를 지원하지 않습니다",
    );
    await backend.setEffort("ultra");
    const secondSubmission = await backend.submitText("두 번째 턴");
    expect(secondSubmission).toEqual({ turnId: "turn_2", steered: false });
    const staleRetrySubmission = await backend.submitText("stale steer 뒤 새 턴");
    expect(staleRetrySubmission).toEqual({ turnId: "turn_3", steered: false });
    expect(backend.currentTurnId).toBe("turn_3");
    const activeCapture = await backend.captureStatus(true);
    await backend.compact("API 변경을 우선 보존");
    await backend.setGoal("완료 조건", "discord", {
      chat_id: "C1",
      message_id: "M-goal",
    });
    expect(backend.hasActiveGoal).toBe(true);
    await backend.setEffort("high");
    expect(backend.currentEffort).toBe("high");
    await backend.setGoal("clear", "discord", {
      chat_id: "C1",
      message_id: "M-goal-clear",
    });
    expect(backend.hasActiveGoal).toBe(false);
    await backend.setEffort("ultra");
    await backend.newSession({ model: "gpt-next", cwd: tempDir });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const threadStart = messages.find((message) => message.method === "thread/start");
    const turnStarts = messages.filter((message) => message.method === "turn/start");
    const answer = messages.find((message) => message.id === "ask_1");
    const foreignAnswer = messages.find(
      (message) => message.id === "ask_foreign",
    );
    const secretAnswer = messages.find(
      (message) => message.id === "ask_secret",
    );
    const freeformCancelAnswer = messages.find(
      (message) => message.id === "ask_freeform_cancel",
    );
    const deadlineAnswer = messages.find(
      (message) => message.id === "ask_deadline",
    );
    const expiredAnswer = messages.find(
      (message) => message.id === "ask_expired",
    );
    const commandApprovalAnswer = messages.find(
      (message) => message.id === "approve_command",
    );
    const emptyCommandApprovalAnswer = messages.find(
      (message) => message.id === "approve_command_empty",
    );
    const fileApprovalAnswer = messages.find(
      (message) => message.id === "approve_file",
    );
    const permissionsApprovalAnswer = messages.find(
      (message) => message.id === "approve_permissions",
    );
    const goalSet = messages.find((message) => message.method === "thread/goal/set");
    const injectedContexts = messages.filter(
      (message) => message.method === "thread/inject_items",
    );
    const compactContext = injectedContexts.find(
      (message) =>
        message.params.items[0]?.content[0]?.text?.includes(
          "[Compact Bot compaction hint]",
        ),
    );
    const compactContextIndex = messages.indexOf(compactContext);
    const compactStartIndex = messages.findIndex(
      (message) => message.method === "thread/compact/start",
    );
    const goalContext = injectedContexts.find(
      (message) =>
        message.params.items[0]?.content[0]?.text?.includes("/goal 완료 조건"),
    );
    const interrupt = messages.find((message) => message.method === "turn/interrupt");
    const threadStarts = messages.filter((message) => message.method === "thread/start");
    const modelLists = messages.filter((message) => message.method === "model/list");
    const processStarts = messages.filter(
      (message) => message.event === "process/start",
    );
    const processExits = messages.filter(
      (message) => message.event === "process/exit",
    );
    const cleanupStart = messages.findLastIndex(
      (message) => message.method === "thread/goal/clear",
    );

    expect(threadStart.params).toMatchObject({
      cwd: tempDir,
      model: "gpt-test",
      config: { model_reasoning_effort: "high" },
      developerInstructions: "Use the reply tool.",
      sandbox: "workspace-write",
    });
    expect(turnStarts[0].params.effort).toBe("high");
    expect(turnStarts[0].params.input[0].text).toContain(
      '<channel source="discord" chat_id="C1" message_id="M1">',
    );
    expect(turnStarts[1].params).toMatchObject({
      threadId: firstThreadId,
      effort: "ultra",
      input: [{ type: "text", text: "두 번째 턴" }],
    });
    expect(turnStarts[2].params).toMatchObject({
      threadId: firstThreadId,
      effort: "ultra",
      input: [{ type: "text", text: "stale steer 뒤 새 턴" }],
    });
    expect(answer.result).toEqual({
      answers: { scope: { answers: ["전체"] } },
    });
    expect(foreignAnswer.result).toEqual({ answers: {} });
    expect(secretAnswer.result).toEqual({ answers: {} });
    expect(freeformCancelAnswer.result).toEqual({ answers: {} });
    expect(deadlineAnswer.result).toEqual({
      answers: {
        empty: { answers: [] },
        later: { answers: ["B"] },
      },
    });
    expect(expiredAnswer.result).toEqual({ answers: {} });
    expect(commandApprovalAnswer.result).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: { command_prefix: ["npm", "test"] },
        },
      },
    });
    expect(emptyCommandApprovalAnswer.result).toEqual({
      decision: "decline",
    });
    expect(fileApprovalAnswer.result).toEqual({ decision: "accept" });
    expect(permissionsApprovalAnswer.result).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["/workspace"] },
      },
      scope: "session",
    });

    const scopeQuestion = questions.find(
      (question) => question.header === "범위",
    );
    const freeformQuestion = questions.find(
      (question) => question.header === "자유 입력",
    );
    const firstDeadlineQuestion = questions.find(
      (question) => question.header === "마감 1",
    );
    const secondDeadlineQuestion = questions.find(
      (question) => question.header === "마감 2",
    );
    const expiredQuestion = questions.find(
      (question) => question.header === "마감 초과",
    );
    const commandApprovalQuestion = questions.find(
      (question) =>
        typeof question.question === "string" &&
        question.question.includes("npm test"),
    );
    const emptyCommandApprovalQuestion = questions.find(
      (question) =>
        typeof question.question === "string" &&
        question.question.includes("echo blocked"),
    );
    const fileApprovalQuestion = questions.find(
      (question) =>
        typeof question.question === "string" &&
        question.question.includes("파일 변경 허용"),
    );
    const permissionsApprovalQuestion = questions.find(
      (question) =>
        typeof question.question === "string" &&
        question.question.includes("추가 권한"),
    );
    expect(scopeQuestion).toMatchObject({
      threadId: firstThreadId,
      turnId: "turn_1",
      itemId: "item_1",
      autoResolutionMs: null,
      isOther: true,
      isSecret: false,
    });
    expect(freeformQuestion).toMatchObject({
      autoResolutionMs: null,
      isOther: true,
      isSecret: false,
      options: [],
    });
    expect(firstDeadlineQuestion).toMatchObject({
      isOther: false,
      autoResolutionMs: expect.any(Number),
    });
    expect(secondDeadlineQuestion).toMatchObject({
      isOther: false,
      autoResolutionMs: expect.any(Number),
    });
    expect(
      secondDeadlineQuestion?.autoResolutionMs as number,
    ).toBeLessThan(
      firstDeadlineQuestion?.autoResolutionMs as number,
    );
    expect(expiredQuestion).toMatchObject({
      autoResolutionMs: expect.any(Number),
    });
    expect(commandApprovalQuestion).toMatchObject({
      isOther: false,
      options: [
        { label: "실행 규칙 추가 후 허용" },
        { label: "거부" },
      ],
    });
    expect(commandApprovalQuestion?.question).toContain("명령 작업");
    expect(commandApprovalQuestion?.question).toContain(
      "네트워크 승인 컨텍스트",
    );
    expect(commandApprovalQuestion?.question).toContain("제안된 실행 규칙");
    expect(commandApprovalQuestion?.question).toContain(
      "제안된 네트워크 규칙",
    );
    expect(emptyCommandApprovalQuestion).toMatchObject({
      isOther: false,
      options: [{ label: "거부" }],
    });
    expect(fileApprovalQuestion).toMatchObject({ isOther: false });
    expect(permissionsApprovalQuestion).toMatchObject({ isOther: false });
    expect(goalSet.params).toMatchObject({
      threadId: firstThreadId,
      objective: "완료 조건",
    });
    expect(goalContext.params).toMatchObject({
      threadId: firstThreadId,
      items: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: expect.stringContaining(
            '<channel source="discord" chat_id="C1" message_id="M-goal">',
          ),
        }],
      }],
    });
    expect(
      injectedContexts.some((message) =>
        message.params.items[0]?.content[0]?.text?.includes("/goal clear")
      ),
    ).toBe(false);
    expect(compactContext.params).toMatchObject({
      threadId: firstThreadId,
      items: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: "[Compact Bot compaction hint]\nAPI 변경을 우선 보존",
        }],
      }],
    });
    expect(compactContextIndex).toBeGreaterThanOrEqual(0);
    expect(compactStartIndex).toBeGreaterThan(compactContextIndex);
    expect(interrupt.params).toEqual({
      threadId: firstThreadId,
      turnId: "turn_goal",
    });
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[1].params.config).toBeUndefined();
    expect(backend.currentThreadId).not.toBe(firstThreadId);
    expect(backend.currentModel).toBe("gpt-next");
    expect(backend.currentEffort).toBe("medium");
    expect(backend.availableEfforts).toEqual(["low", "medium", "high"]);
    expect(backend.effortForModel("gpt-next", "ultra")).toBe("");
    expect(backend.effortForModel("unknown-model", "ultra")).toBe("ultra");
    expect(modelLists.length).toBeGreaterThanOrEqual(4);
    expect(modelLists.length % 2).toBe(0);
    for (let index = 0; index < modelLists.length; index += 2) {
      expect(modelLists.slice(index, index + 2).map(
        (message) => message.params.cursor ?? null,
      )).toEqual([null, "page_2"]);
    }
    expect(
      messages
        .slice(cleanupStart)
        .filter(
          (message) =>
            message.method && message.method !== "model/list",
        )
        .slice(0, 3)
        .map((message) => message.method),
    ).toEqual([
      "thread/goal/clear",
      "turn/interrupt",
      "thread/unsubscribe",
    ]);
    expect(processStarts).toHaveLength(2);
    expect(processExits).toEqual([
      { event: "process/exit", pid: processStarts[0].pid },
    ]);

    expect(captureAll).toContain("line-0");
    expect(captureAll).toContain("ASSISTANT\ncapture answer");
    expect(captureAll).toContain("$ npm test");
    expect(captureAll).toContain("all tests passed");
    expect(captureAll).toContain("MCP compact_bot/reply (completed)");
    expect(captureAll.length).toBeLessThan(530_000);
    expect(captureAll.indexOf("line-0")).toBeLessThan(
      captureAll.indexOf("ASSISTANT\ncapture answer"),
    );
    expect(captureViewport).not.toContain("line-0");
    expect(captureViewport).not.toContain("line-59");
    expect(captureViewport).toContain("older transcript content omitted");
    expect(captureViewport.length).toBeLessThan(530_000);
    expect(captureViewport).toContain("Compact Bot · Codex app-server");
    expect(activeCapture).toContain("── LIVE TURN turn_3 ──");
    expect(activeCapture).toContain("ASSISTANT (live)\n실시간 답변");
    expect(activeCapture).toContain("COMMAND OUTPUT (live)\n실시간 명령 출력");
    expect(
      messages.filter((message) => message.method === "thread/turns/list")
        .map((message) => message.params),
    ).toEqual([
      {
        threadId: firstThreadId,
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      },
      {
        threadId: firstThreadId,
        cursor: "page_2",
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      },
      {
        threadId: firstThreadId,
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      },
      {
        threadId: firstThreadId,
        cursor: "page_2",
        limit: 50,
        sortDirection: "desc",
        itemsView: "full",
      },
    ]);
    expect(
      messages.filter((message) => message.method === "thread/read"),
    ).toHaveLength(0);
    expect(
      notifications.filter(
        ({ method, params }) =>
          method === "item/completed" &&
          (params.item as { type?: string } | undefined)?.type !==
            "contextCompaction",
      ),
    ).toHaveLength(1);
    expect(
      notifications.find(
        ({ method, params }) =>
          method === "item/completed" &&
          (params.item as { type?: string } | undefined)?.type !==
            "contextCompaction",
      )?.params,
    ).toMatchObject({
      threadId: firstThreadId,
      item: { id: "current_item" },
    });

    const secondThreadId = backend.currentThreadId;
    await backend.submitText("closeSession cleanup");
    await backend.closeSession();
    const messagesAfterClose = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const lastGoalClear = messagesAfterClose.findLastIndex(
      (message) => message.method === "thread/goal/clear",
    );
    expect(
      messagesAfterClose
        .slice(lastGoalClear)
        .filter((message) => message.method)
        .slice(0, 3)
        .map((message) => message.method),
    ).toEqual([
      "thread/goal/clear",
      "turn/interrupt",
      "thread/unsubscribe",
    ]);
    expect(messagesAfterClose[lastGoalClear].params.threadId).toBe(
      secondThreadId,
    );
    expect(
      messagesAfterClose.filter(
        (message) => message.event === "process/exit",
      ),
    ).toHaveLength(2);
    expect(backend.currentThreadId).toBeNull();
  });
});
