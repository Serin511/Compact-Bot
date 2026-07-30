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
          item: { id: "current_item", type: "agentMessage", text: "current" }
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
  } else if (msg.method === "thread/read") {
    const lines = Array.from({ length: 60 }, (_, index) => "line-" + index).join("\\n");
    send({
      id: msg.id,
      result: {
        thread: {
          id: msg.params.threadId,
          turns: [{
            id: "turn_capture",
            status: "completed",
            error: null,
            items: [
              {
                id: "user_capture",
                type: "userMessage",
                content: [{ type: "text", text: lines }]
              },
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
          }]
        }
      }
    });
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
    }
  } else if (msg.method === "thread/compact/start" ||
             msg.method === "thread/goal/set" ||
             msg.method === "thread/inject_items") {
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
    expect(() => backend?.setEffort("minimal")).toThrow(
      "gpt-test은 minimal effort를 지원하지 않습니다",
    );
    backend.setEffort("ultra");
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
    await backend.setGoal("clear", "discord", {
      chat_id: "C1",
      message_id: "M-goal-clear",
    });
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
      turnId: "turn_3",
    });
    expect(threadStarts).toHaveLength(2);
    expect(threadStarts[1].params.config).toBeUndefined();
    expect(backend.currentThreadId).not.toBe(firstThreadId);
    expect(backend.currentModel).toBe("gpt-next");
    expect(backend.currentEffort).toBe("medium");
    expect(backend.availableEfforts).toEqual(["low", "medium", "high"]);
    expect(backend.effortForModel("gpt-next", "ultra")).toBe("");
    expect(backend.effortForModel("unknown-model", "ultra")).toBe("ultra");
    expect(modelLists.map((message) => message.params.cursor ?? null)).toEqual([
      null,
      "page_2",
      null,
      "page_2",
    ]);
    expect(
      messages
        .slice(cleanupStart)
        .filter((message) => message.method)
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
    expect(captureViewport).not.toContain("line-0");
    expect(captureViewport).toContain("line-59");
    expect(captureViewport).toContain("Compact Bot · Codex app-server");
    expect(activeCapture).toContain("── LIVE TURN turn_3 ──");
    expect(activeCapture).toContain("ASSISTANT (live)\n실시간 답변");
    expect(activeCapture).toContain("COMMAND OUTPUT (live)\n실시간 명령 출력");
    expect(
      notifications.filter(
        ({ method }) => method === "item/completed",
      ),
    ).toHaveLength(1);
    expect(
      notifications.find(
        ({ method }) => method === "item/completed",
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
