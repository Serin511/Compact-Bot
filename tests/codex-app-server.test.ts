import { afterEach, describe, expect, it } from "vitest";
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
} from "../src/codex-app-server.js";

describe("Codex app-server helpers", () => {
  it("builds MCP overrides without embedding token values", () => {
    const args = buildCodexAppServerArgs([
      {
        name: "compact_bot_discord",
        command: "node",
        args: ["/pkg/mcp-server.js"],
        envVars: ["DISCORD_BOT_TOKEN", "WRAPPER_SOCKET"],
      },
    ]);
    const rendered = args.join(" ");

    expect(args[0]).toBe("app-server");
    expect(rendered).toContain('mcp_servers.compact_bot_discord.command="node"');
    expect(rendered).toContain(
      'mcp_servers.compact_bot_discord.env_vars=["DISCORD_BOT_TOKEN","WRAPPER_SOCKET"]',
    );
    expect(rendered).toContain(
      'mcp_servers.compact_bot_discord.default_tools_approval_mode="approve"',
    );
    expect(rendered).not.toContain("secret-token-value");
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
let thread = 0;
let turn = 0;
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  log(msg);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { userAgent: "fake" } });
  } else if (msg.method === "thread/start") {
    thread += 1;
    send({
      id: msg.id,
      result: {
        thread: { id: "thr_" + thread },
        model: msg.params.model || "gpt-test",
        reasoningEffort:
          msg.params.config?.model_reasoning_effort || "medium"
      }
    });
  } else if (msg.method === "model/list") {
    const effortsByModel = {
      "gpt-test": ["low", "high", "ultra"],
      "gpt-next": ["low", "medium", "high"]
    };
    send({
      id: msg.id,
      result: {
        data: Object.entries(effortsByModel).map(([model, efforts]) => ({
          id: model,
          model,
          supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
            reasoningEffort,
            description: reasoningEffort
          }))
        }))
      }
    });
  } else if (msg.method === "turn/start") {
    turn += 1;
    const turnId = "turn_" + turn;
    const threadId = "thr_" + thread;
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
      setTimeout(() => {
        send({
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, status: "completed", error: null }
          }
        });
      }, 10);
    }
  } else if (msg.method === "thread/compact/start" ||
             msg.method === "thread/goal/set" ||
             msg.method === "thread/goal/clear" ||
             msg.method === "turn/steer" ||
             msg.method === "turn/interrupt") {
    send({ id: msg.id, result: {} });
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
    );
    chmodSync(executable, 0o755);

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
      onQuestion: async () => "2",
    });

    await backend.start();
    expect(backend.currentThreadId).toBe("thr_1");

    await backend.submitChannelMessage("discord", "테스트", {
      chat_id: "C1",
      message_id: "M1",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(backend.currentTurnId).toBeNull();
    expect(() => backend?.setEffort("minimal")).toThrow(
      "gpt-test은 minimal effort를 지원하지 않습니다",
    );
    backend.setEffort("ultra");
    await backend.submitText("두 번째 턴");
    await backend.setGoal("완료 조건");
    await backend.newSession({ model: "gpt-next", cwd: tempDir });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const messages = readFileSync(logPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const threadStart = messages.find((message) => message.method === "thread/start");
    const turnStarts = messages.filter((message) => message.method === "turn/start");
    const answer = messages.find((message) => message.id === "ask_1");
    const goalSet = messages.find((message) => message.method === "thread/goal/set");
    const interrupt = messages.find((message) => message.method === "turn/interrupt");
    const threadStarts = messages.filter((message) => message.method === "thread/start");

    expect(threadStart.params).toMatchObject({
      cwd: tempDir,
      model: "gpt-test",
      config: { model_reasoning_effort: "high" },
      developerInstructions: "Use the reply tool.",
    });
    expect(turnStarts[0].params.effort).toBe("high");
    expect(turnStarts[0].params.input[0].text).toContain(
      '<channel source="discord" chat_id="C1" message_id="M1">',
    );
    expect(turnStarts[1].params).toMatchObject({
      threadId: "thr_1",
      effort: "ultra",
      input: [{ type: "text", text: "두 번째 턴" }],
    });
    expect(answer.result).toEqual({
      answers: { scope: { answers: ["전체"] } },
    });
    expect(goalSet.params).toMatchObject({
      threadId: "thr_1",
      objective: "완료 조건",
    });
    expect(interrupt.params).toEqual({
      threadId: "thr_1",
      turnId: "turn_2",
    });
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[1].params.config).toBeUndefined();
    expect(backend.currentThreadId).toBe("thr_2");
    expect(backend.currentModel).toBe("gpt-next");
    expect(backend.currentEffort).toBe("medium");
    expect(backend.availableEfforts).toEqual(["low", "medium", "high"]);
  });
});
