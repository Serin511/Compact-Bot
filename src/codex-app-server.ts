/**
 * Codex app-server client used by Compact Bot's Codex backend.
 *
 * Codex does not implement Claude Code's MCP Channel notification extension.
 * Instead, the wrapper owns a `codex app-server` process, sends Discord/Slack
 * messages through the thread/turn JSON-RPC API, and still exposes the existing
 * platform MCP servers so Codex can reply, react, edit, and fetch history.
 */

import { EventEmitter } from "node:events";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  normalizeReasoningEffort,
} from "./reasoning-effort.js";

export type JsonRpcId = string | number;

export interface CodexMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  envVars: string[];
}

export interface CodexQuestion {
  header?: string;
  question: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
}

export interface CodexAppServerOptions {
  executable: string;
  cwd: string;
  model: string;
  effort: string;
  dangerouslySkipPermissions: boolean;
  developerInstructions: string;
  mcpServers: CodexMcpServerConfig[];
  env: Record<string, string>;
  onQuestion: (question: CodexQuestion) => Promise<string>;
  onDebug?: (message: string) => void;
  onError?: (message: string, error?: unknown) => void;
}

interface JsonRpcMessage {
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ThreadStartResult {
  thread?: {
    id?: string;
  };
  model?: string;
  reasoningEffort?: string | null;
}

interface TurnStartResult {
  turn?: {
    id?: string;
  };
}

interface ModelListResult {
  data?: Array<{
    id?: string;
    model?: string;
    hidden?: boolean;
    supportedReasoningEfforts?: Array<{
      reasoningEffort?: string;
    }>;
  }>;
}

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;

function tomlString(value: string): string {
  // JSON string syntax is valid TOML basic-string syntax for the characters
  // that can occur in executable paths, arguments, and environment names.
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

/**
 * Build process-local MCP overrides for `codex app-server`.
 *
 * We forward tokens by environment-variable name instead of embedding secret
 * values in argv. `approve` keeps the bot's own reply/react tools from asking
 * for approval every time Codex needs to communicate with the user.
 */
export function buildCodexAppServerArgs(
  servers: CodexMcpServerConfig[],
): string[] {
  const args = ["app-server"];
  for (const server of servers) {
    const prefix = `mcp_servers.${server.name}`;
    args.push("-c", `${prefix}.command=${tomlString(server.command)}`);
    args.push("-c", `${prefix}.args=${tomlStringArray(server.args)}`);
    args.push("-c", `${prefix}.env_vars=${tomlStringArray(server.envVars)}`);
    args.push("-c", `${prefix}.required=true`);
    args.push("-c", `${prefix}.default_tools_approval_mode="approve"`);
  }
  return args;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Render the same channel envelope Claude Code normally constructs for an MCP
 * Channel notification. Keeping this wire shape stable lets both agents follow
 * the MCP server instructions and reuse chat metadata consistently.
 */
export function formatChannelMessage(
  source: "discord" | "slack",
  content: string,
  meta: Record<string, string>,
): string {
  const attrs = Object.entries(meta)
    .map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
    .join(" ");
  const suffix = attrs ? ` ${attrs}` : "";
  return `<channel source="${source}"${suffix}>\n${content}\n</channel>`;
}

function displayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeChoice(answer: string, options: CodexQuestion["options"]): string {
  const trimmed = answer.trim();
  const match = /^(\d+)$/.exec(trimmed);
  if (match) {
    const index = Number(match[1]) - 1;
    if (index >= 0 && index < options.length) {
      return options[index].label;
    }
  }
  return trimmed;
}

/**
 * Minimal, version-tolerant client for Codex's newline-delimited app-server
 * protocol. Unknown notifications are retained in the status buffer and
 * unknown server requests are declined with a JSON-RPC error instead of being
 * left hanging.
 */
export class CodexAppServer extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private operationQueue: Promise<void> = Promise.resolve();
  private stopping = false;
  private initialized = false;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private cwd: string;
  private model: string;
  private effort: string;
  private supportedReasoningEfforts: string[] = [];
  private readonly reasoningEffortsByModel = new Map<string, string[]>();
  private readonly recentEvents: string[] = [];

  constructor(private readonly options: CodexAppServerOptions) {
    super();
    this.cwd = options.cwd;
    this.model = options.model;
    this.effort = options.effort;
  }

  get currentThreadId(): string | null {
    return this.threadId;
  }

  get currentTurnId(): string | null {
    return this.activeTurnId;
  }

  get currentCwd(): string {
    return this.cwd;
  }

  get currentModel(): string {
    return this.model;
  }

  get currentEffort(): string {
    return this.effort;
  }

  get availableEfforts(): string[] {
    return [...this.supportedReasoningEfforts];
  }

  async start(): Promise<void> {
    if (this.child) return;

    const args = buildCodexAppServerArgs(this.options.mcpServers);
    this.options.onDebug?.(
      `Starting Codex app-server: ${this.options.executable} ${args.join(" ")}`,
    );

    this.stopping = false;
    const child = spawn(this.options.executable, args, {
      cwd: this.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) this.options.onDebug?.(`[codex] ${text}`);
    });
    child.on("error", (error) => {
      this.options.onError?.("Codex app-server process error", error);
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      this.initialized = false;
      this.threadId = null;
      this.activeTurnId = null;
      const error = new Error(
        `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.emit("exit", { code, signal, expected: this.stopping });
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "compact_bot",
        title: "Compact Bot",
        version: "1.4.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
    await this.startThread();
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("exit", finish);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (this.child === child) child.kill("SIGKILL");
        finish();
      }, STOP_TIMEOUT_MS).unref();
    });
  }

  async newSession(updates?: {
    model?: string;
    cwd?: string;
    effort?: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      const previous = {
        threadId: this.threadId,
        activeTurnId: this.activeTurnId,
        model: this.model,
        cwd: this.cwd,
        effort: this.effort,
        supportedReasoningEfforts: [...this.supportedReasoningEfforts],
      };
      const nextModel = updates?.model ?? this.model;
      const nextCwd = updates?.cwd ?? this.cwd;
      let nextEffort = updates?.effort ?? this.effort;
      const nextModelEfforts =
        this.reasoningEffortsByModel.get(nextModel) ?? [];
      if (
        nextEffort &&
        nextModelEfforts.length > 0 &&
        !nextModelEfforts.includes(nextEffort)
      ) {
        this.options.onDebug?.(
          `${nextModel} does not advertise reasoning effort ${nextEffort}; using the model default`,
        );
        nextEffort = "";
      }

      let restoreActiveTurnId = previous.activeTurnId;
      if (this.threadId && this.activeTurnId) {
        try {
          await this.request("turn/interrupt", {
            threadId: this.threadId,
            turnId: this.activeTurnId,
          });
          restoreActiveTurnId = null;
        } catch (error) {
          this.options.onDebug?.(
            `Could not interrupt previous Codex turn before starting a new thread: ${String(error)}`,
          );
        }
      }
      this.model = nextModel;
      this.cwd = nextCwd;
      this.effort = nextEffort;
      try {
        await this.startThread();
      } catch (error) {
        this.threadId = previous.threadId;
        this.activeTurnId = restoreActiveTurnId;
        this.model = previous.model;
        this.cwd = previous.cwd;
        this.effort = previous.effort;
        this.supportedReasoningEfforts =
          previous.supportedReasoningEfforts;
        throw error;
      }
    });
  }

  async submitChannelMessage(
    source: "discord" | "slack",
    content: string,
    meta: Record<string, string>,
  ): Promise<void> {
    await this.submitText(formatChannelMessage(source, content, meta));
  }

  async submitText(text: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      const input = [{ type: "text", text }];
      if (this.activeTurnId) {
        await this.request("turn/steer", {
          threadId: this.threadId,
          input,
          expectedTurnId: this.activeTurnId,
        });
        return;
      }

      const result = (await this.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      })) as TurnStartResult;
      this.activeTurnId = result.turn?.id ?? this.activeTurnId;
    });
  }

  async compact(_hint?: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      await this.request("thread/compact/start", { threadId: this.threadId });
    });
  }

  async interrupt(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.threadId || !this.activeTurnId) return;
      await this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    });
  }

  async setGoal(args: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      if (args.trim() === "clear") {
        await this.request("thread/goal/clear", { threadId: this.threadId });
      } else {
        await this.request("thread/goal/set", {
          threadId: this.threadId,
          objective: args.trim(),
        });
      }
    });
  }

  /**
   * Change the reasoning effort used for the next new turn.
   *
   * `turn/start.effort` becomes the thread default for later turns. An active
   * turn cannot be mutated, so a change made while Codex is working applies
   * after that turn completes.
   */
  setEffort(value: string): void {
    const normalized = normalizeReasoningEffort(value);
    if (!normalized) {
      throw new Error(`지원하지 않는 reasoning effort: ${value}`);
    }
    if (
      this.supportedReasoningEfforts.length > 0 &&
      !this.supportedReasoningEfforts.includes(normalized)
    ) {
      throw new Error(
        `${this.model || "현재 모델"}은 ${normalized} effort를 지원하지 않습니다`,
      );
    }
    this.effort = normalized;
    this.recordEvent(`reasoning effort changed: ${normalized}`);
  }

  captureStatus(all = false): string {
    const events = all ? this.recentEvents : this.recentEvents.slice(-12);
    return [
      "Compact Bot · Codex app-server",
      `thread: ${this.threadId ?? "(starting)"}`,
      `turn: ${this.activeTurnId ?? "(idle)"}`,
      `model: ${this.model || "(Codex default)"}`,
      `effort: ${this.effort || "(Codex default)"}`,
      `cwd: ${this.cwd}`,
      "",
      ...events,
    ].join("\n").trimEnd();
  }

  private async startThread(): Promise<void> {
    if (!this.initialized) throw new Error("Codex app-server is not initialized");
    this.activeTurnId = null;
    const params: Record<string, unknown> = {
      cwd: this.cwd,
      serviceName: "compact_bot",
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort
        ? { config: { model_reasoning_effort: this.effort } }
        : {}),
      ...(this.options.developerInstructions
        ? { developerInstructions: this.options.developerInstructions }
        : {}),
    };
    if (this.options.dangerouslySkipPermissions) {
      params.approvalPolicy = "never";
      params.sandbox = "danger-full-access";
    }

    const result = (await this.request("thread/start", params)) as ThreadStartResult;
    const threadId = result.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    this.threadId = threadId;
    this.model = result.model ?? this.model;
    this.effort = result.reasoningEffort ?? this.effort;
    await this.refreshModelCapabilities();
    this.recordEvent(`thread started: ${threadId}`);
    this.emit("thread", {
      threadId,
      model: this.model,
      effort: this.effort,
      availableEfforts: this.availableEfforts,
      cwd: this.cwd,
    });
  }

  private async refreshModelCapabilities(): Promise<void> {
    try {
      const result = (await this.request("model/list", {
        includeHidden: true,
      })) as ModelListResult;
      const models = result.data ?? [];
      this.reasoningEffortsByModel.clear();
      for (const entry of models) {
        const efforts = [
          ...new Set(
            (entry.supportedReasoningEfforts ?? [])
              .map((option) => option.reasoningEffort ?? "")
              .filter(Boolean),
          ),
        ];
        if (entry.id) this.reasoningEffortsByModel.set(entry.id, efforts);
        if (entry.model) this.reasoningEffortsByModel.set(entry.model, efforts);
      }
      this.supportedReasoningEfforts = [
        ...(this.reasoningEffortsByModel.get(this.model) ?? []),
      ];
    } catch (error) {
      // Older app-server versions may not expose model/list. Effort still
      // works through turn/start; only model-specific command validation is
      // unavailable in that case.
      this.supportedReasoningEfforts = [];
      this.options.onDebug?.(
        `Could not load Codex reasoning efforts: ${String(error)}`,
      );
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.operationQueue.then(operation);
    this.operationQueue = run.catch((error) => {
      this.options.onError?.("Codex operation failed", error);
    });
    return run;
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ method, params });
  }

  private respond(id: JsonRpcId, result: unknown): void {
    this.send({ id, result });
  }

  private respondError(id: JsonRpcId, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage);
      } catch (error) {
        this.options.onError?.(`Invalid Codex app-server JSON: ${line.slice(0, 300)}`, error);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `Codex request failed (${message.error.code ?? "unknown"}): ${
              message.error.message ?? "unknown error"
            }`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      void this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params ?? {});
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "turn/started") {
      const notificationThreadId = params.threadId as string | undefined;
      if (notificationThreadId && notificationThreadId !== this.threadId) return;
      const turn = params.turn as { id?: string } | undefined;
      this.activeTurnId = turn?.id ?? this.activeTurnId;
      this.recordEvent(`turn started: ${this.activeTurnId ?? "unknown"}`);
    } else if (method === "turn/completed") {
      const notificationThreadId = params.threadId as string | undefined;
      if (notificationThreadId && notificationThreadId !== this.threadId) return;
      const turn = params.turn as {
        id?: string;
        status?: string;
        error?: { message?: string } | null;
      } | undefined;
      this.recordEvent(
        `turn ${turn?.status ?? "completed"}: ${turn?.id ?? this.activeTurnId ?? "unknown"}`,
      );
      if (turn?.error?.message) this.recordEvent(`error: ${turn.error.message}`);
      this.activeTurnId = null;
    } else if (method === "item/completed") {
      const item = params.item as {
        type?: string;
        tool?: string;
        status?: string;
      } | undefined;
      if (item?.type && item.type !== "reasoning") {
        const detail = item.tool ? ` ${item.tool}` : "";
        this.recordEvent(`${item.type}${detail}${item.status ? `: ${item.status}` : ""}`);
      }
    } else if (method === "warning" || method === "error" || method === "configWarning") {
      const text =
        (params.message as string | undefined) ??
        (params.summary as string | undefined) ??
        displayJson(params);
      this.recordEvent(`${method}: ${text}`);
      this.options.onError?.(`Codex ${method}: ${text}`);
    }
    this.emit("notification", { method, params });
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    const method = message.method;
    const params = message.params ?? {};
    if (id === undefined || !method) return;

    try {
      switch (method) {
        case "item/tool/requestUserInput": {
          const questions = Array.isArray(params.questions)
            ? (params.questions as Array<{
                id?: string;
                header?: string;
                question?: string;
                options?: Array<{ label?: string; description?: string }> | null;
              }>)
            : [];
          const answers: Record<string, { answers: string[] }> = {};
          for (let index = 0; index < questions.length; index++) {
            const question = questions[index];
            const options = (question.options ?? []).map((option) => ({
              label: option.label ?? "",
              description: option.description ?? "",
            }));
            const uiQuestion: CodexQuestion = {
              header: question.header || `질문 ${index + 1}/${questions.length}`,
              question: question.question ?? "",
              options,
            };
            const rawAnswer = await this.options.onQuestion(uiQuestion);
            const answer = normalizeChoice(rawAnswer, options);
            answers[question.id ?? String(index)] = { answers: [answer] };
          }
          this.respond(id, { answers });
          return;
        }

        case "item/commandExecution/requestApproval": {
          const command = String(params.command ?? "(명령 정보 없음)");
          const reason = params.reason ? `\n이유: ${String(params.reason)}` : "";
          const cwd = params.cwd ? `\n위치: ${String(params.cwd)}` : "";
          const options = [
            { label: "이번만 허용", description: "이 명령 한 번만 실행합니다." },
            { label: "세션 동안 허용", description: "이 세션의 유사 요청을 계속 허용합니다." },
            { label: "거부", description: "명령을 실행하지 않습니다." },
          ];
          const answer = normalizeChoice(
            await this.options.onQuestion({
              header: "Codex 권한",
              question: `다음 명령 실행을 허용할까요?\n\n${command}${cwd}${reason}`,
              options,
            }),
            options,
          );
          const decision = answer === options[0].label
            ? "accept"
            : answer === options[1].label
              ? "acceptForSession"
              : "decline";
          this.respond(id, { decision });
          return;
        }

        case "item/fileChange/requestApproval": {
          const reason = params.reason ? String(params.reason) : "파일 변경";
          const root = params.grantRoot ? `\n범위: ${String(params.grantRoot)}` : "";
          const options = [
            { label: "이번만 허용", description: "이번 파일 변경만 적용합니다." },
            { label: "세션 동안 허용", description: "이 세션의 파일 변경을 계속 허용합니다." },
            { label: "거부", description: "파일을 변경하지 않습니다." },
          ];
          const answer = normalizeChoice(
            await this.options.onQuestion({
              header: "Codex 권한",
              question: `${reason}${root}`,
              options,
            }),
            options,
          );
          const decision = answer === options[0].label
            ? "accept"
            : answer === options[1].label
              ? "acceptForSession"
              : "decline";
          this.respond(id, { decision });
          return;
        }

        case "item/permissions/requestApproval": {
          const requested = params.permissions ?? {};
          const options = [
            { label: "이번 턴 허용", description: "요청한 권한을 이번 턴에만 부여합니다." },
            { label: "세션 동안 허용", description: "요청한 권한을 현재 세션에 부여합니다." },
            { label: "거부", description: "추가 권한을 부여하지 않습니다." },
          ];
          const answer = normalizeChoice(
            await this.options.onQuestion({
              header: "Codex 권한",
              question: `${String(params.reason ?? "추가 권한 요청")}\n\n${displayJson(requested)}`,
              options,
            }),
            options,
          );
          const accepted = answer === options[0].label || answer === options[1].label;
          const requestedProfile =
            requested && typeof requested === "object"
              ? (requested as Record<string, unknown>)
              : {};
          const granted: Record<string, unknown> = {};
          if (accepted && requestedProfile.network != null) {
            granted.network = requestedProfile.network;
          }
          if (accepted && requestedProfile.fileSystem != null) {
            granted.fileSystem = requestedProfile.fileSystem;
          }
          this.respond(id, {
            permissions: granted,
            scope: answer === options[1].label ? "session" : "turn",
          });
          return;
        }

        case "mcpServer/elicitation/request":
          // Compact Bot's own Discord/Slack MCP servers do not issue
          // elicitations. Decline third-party forms rather than hanging the
          // active turn with a UI shape we cannot render faithfully.
          this.respond(id, { action: "decline", content: null, _meta: null });
          return;

        default:
          this.respondError(id, `Unsupported app-server request: ${method}`);
      }
    } catch (error) {
      this.options.onError?.(`Failed to handle Codex server request: ${method}`, error);
      if (method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval") {
        this.respond(id, { decision: "decline" });
      } else if (method === "item/tool/requestUserInput") {
        this.respond(id, { answers: {} });
      } else {
        this.respondError(id, `Compact Bot could not handle ${method}`);
      }
    }
  }

  private recordEvent(event: string): void {
    this.recentEvents.push(`[${new Date().toISOString()}] ${event}`);
    if (this.recentEvents.length > 200) this.recentEvents.splice(0, 50);
  }
}
