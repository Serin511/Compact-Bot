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
  threadId?: string;
  turnId?: string;
  itemId?: string;
  autoResolutionMs?: number | null;
  isOther?: boolean;
  isSecret?: boolean;
  header?: string;
  question: string;
  options: Array<{
    label: string;
    description?: string;
  }>;
}

export interface CodexSubmissionResult {
  /** Turn that accepted the submitted input. */
  turnId: string;
  /** True when the input was steered into an already-active turn. */
  steered: boolean;
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
  /**
   * Return null when the whole server-side request should be abandoned.
   *
   * Empty string is a valid "no selections" answer and is encoded as an empty
   * answers array. `autoResolutionMs: null` means the UI may wait indefinitely.
   */
  onQuestion: (question: CodexQuestion) => Promise<string | null>;
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
  nextCursor?: string | null;
}

interface ThreadReadResult {
  thread?: {
    id?: string;
    turns?: Array<{
      id?: string;
      status?: string;
      error?: { message?: string } | null;
      items?: Array<Record<string, unknown>>;
    }>;
  };
}

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const SESSION_CLEANUP_TIMEOUT_MS = 2_000;
const CAPTURE_VIEWPORT_LINES = 50;

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

type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: unknown } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: unknown } };

interface CommandApprovalChoice {
  option: CodexQuestion["options"][number];
  decision: CommandApprovalDecision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function commandApprovalChoices(value: unknown): CommandApprovalChoice[] {
  const raw = Array.isArray(value)
    ? value
    : ["accept", "acceptForSession", "decline"];
  const choices: CommandApprovalChoice[] = [];
  const usedLabels = new Set<string>();

  for (const decision of raw) {
    let label = "";
    let description = "";
    let normalized: CommandApprovalDecision | null = null;
    if (decision === "accept") {
      label = "이번만 허용";
      description = "이 명령 한 번만 실행합니다.";
      normalized = decision;
    } else if (decision === "acceptForSession") {
      label = "세션 동안 허용";
      description = "이 세션의 유사 요청을 계속 허용합니다.";
      normalized = decision;
    } else if (decision === "decline") {
      label = "거부";
      description = "명령을 실행하지 않습니다.";
      normalized = decision;
    } else if (decision === "cancel") {
      label = "취소";
      description = "현재 명령 요청을 취소합니다.";
      normalized = decision;
    } else if (
      isRecord(decision) &&
      isRecord(decision.acceptWithExecpolicyAmendment) &&
      "execpolicy_amendment" in decision.acceptWithExecpolicyAmendment
    ) {
      label = "실행 규칙 추가 후 허용";
      description = "제안된 실행 규칙을 추가하고 명령을 허용합니다.";
      normalized = decision as CommandApprovalDecision;
    } else if (
      isRecord(decision) &&
      isRecord(decision.applyNetworkPolicyAmendment) &&
      "network_policy_amendment" in decision.applyNetworkPolicyAmendment
    ) {
      label = "네트워크 규칙 적용";
      description = "제안된 네트워크 규칙을 적용합니다.";
      normalized = decision as CommandApprovalDecision;
    }
    if (!normalized) continue;

    let uniqueLabel = label;
    let suffix = 2;
    while (usedLabels.has(uniqueLabel)) {
      uniqueLabel = `${label} (${suffix++})`;
    }
    usedLabels.add(uniqueLabel);
    choices.push({
      option: { label: uniqueLabel, description },
      decision: normalized,
    });
  }
  if (choices.length === 0) {
    choices.push({
      option: { label: "거부", description: "명령을 실행하지 않습니다." },
      decision: "decline",
    });
  }
  return choices;
}

function approvalDetail(label: string, value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" && !value.trim()) return "";
  return `${label}:\n${typeof value === "string" ? value : displayJson(value)}`;
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

function isStaleTurnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /no active turn/i.test(message) ||
    /turn.+(?:not active|inactive|completed|not found)/i.test(message) ||
    /expected.+turn/i.test(message)
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function renderUserContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return displayJson(entry);
      const item = entry as Record<string, unknown>;
      switch (item.type) {
        case "text":
          return stringValue(item.text);
        case "image":
          return `[image: ${stringValue(item.url)}]`;
        case "localImage":
          return `[local image: ${stringValue(item.path)}]`;
        case "audio":
          return `[audio: ${stringValue(item.url)}]`;
        case "localAudio":
          return `[local audio: ${stringValue(item.path)}]`;
        case "skill":
          return `[skill: ${stringValue(item.name)} (${stringValue(item.path)})]`;
        case "mention":
          return `[mention: ${stringValue(item.name)} (${stringValue(item.path)})]`;
        default:
          return displayJson(item);
      }
    })
    .filter(Boolean)
    .join("\n");
}

function renderMcpResult(value: unknown): string {
  if (!value || typeof value !== "object") return displayJson(value);
  const result = value as Record<string, unknown>;
  const content = Array.isArray(result.content)
    ? result.content.map((entry) => {
        if (!entry || typeof entry !== "object") return displayJson(entry);
        const item = entry as Record<string, unknown>;
        if (item.type === "text") return stringValue(item.text);
        if (item.type === "image") {
          return `[image: ${stringValue(item.mimeType) || "binary"}]`;
        }
        if (item.type === "audio") {
          return `[audio: ${stringValue(item.mimeType) || "binary"}]`;
        }
        if (item.type === "resource") {
          const resource =
            item.resource && typeof item.resource === "object"
              ? item.resource as Record<string, unknown>
              : {};
          return [
            `[resource: ${stringValue(resource.uri) || "embedded"}]`,
            stringValue(resource.text),
          ]
            .filter(Boolean)
            .join("\n");
        }
        const visible = { ...item };
        delete visible.data;
        delete visible.blob;
        return displayJson(visible);
      })
    : [];
  if (result.structuredContent != null) {
    content.push(displayJson(result.structuredContent));
  }
  return content.filter(Boolean).join("\n");
}

function renderThreadItem(item: Record<string, unknown>): string {
  const type = stringValue(item.type) || "unknown";
  switch (type) {
    case "userMessage":
      return `USER\n${renderUserContent(item.content)}`.trimEnd();
    case "agentMessage":
      return `ASSISTANT\n${stringValue(item.text)}`.trimEnd();
    case "plan":
      return `PLAN\n${stringValue(item.text)}`.trimEnd();
    case "reasoning": {
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((part): part is string => typeof part === "string")
        : [];
      return summary.length > 0 ? `REASONING\n${summary.join("\n")}` : "";
    }
    case "commandExecution": {
      const output = stringValue(item.aggregatedOutput).trimEnd();
      const exitCode =
        typeof item.exitCode === "number" ? `[exit ${item.exitCode}]` : "";
      return [
        `COMMAND (${stringValue(item.status) || "unknown"})`,
        `$ ${stringValue(item.command)}`,
        output,
        exitCode,
      ]
        .filter(Boolean)
        .join("\n")
        .trimEnd();
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes)
        ? item.changes.map((change) => {
            if (!change || typeof change !== "object") return displayJson(change);
            const record = change as Record<string, unknown>;
            return [
              `${stringValue(record.kind) || "update"} ${stringValue(record.path)}`,
              stringValue(record.diff).trimEnd(),
            ]
              .filter(Boolean)
              .join("\n");
          })
        : [];
      return [
        `FILE CHANGE (${stringValue(item.status) || "unknown"})`,
        ...changes,
      ]
        .filter(Boolean)
        .join("\n")
        .trimEnd();
    }
    case "mcpToolCall": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      const error =
        item.error && typeof item.error === "object"
          ? `error: ${displayJson(item.error)}`
          : "";
      const result = item.result == null
        ? ""
        : `result: ${renderMcpResult(item.result)}`;
      return [
        `MCP ${server}${server && tool ? "/" : ""}${tool} (${stringValue(item.status) || "unknown"})`,
        `arguments: ${displayJson(item.arguments)}`,
        result,
        error,
      ]
        .filter(Boolean)
        .join("\n")
        .trimEnd();
    }
    case "dynamicToolCall":
      return [
        `TOOL ${stringValue(item.namespace)}${item.namespace ? "/" : ""}${stringValue(item.tool)} (${stringValue(item.status) || "unknown"})`,
        `arguments: ${displayJson(item.arguments)}`,
        item.contentItems == null
          ? ""
          : `result: ${displayJson(item.contentItems)}`,
      ]
        .filter(Boolean)
        .join("\n")
        .trimEnd();
    case "collabAgentToolCall":
      return [
        `COLLAB ${stringValue(item.tool)} (${stringValue(item.status) || "unknown"})`,
        stringValue(item.prompt),
      ]
        .filter(Boolean)
        .join("\n")
        .trimEnd();
    case "subAgentActivity":
      return `SUBAGENT ${stringValue(item.kind)}: ${stringValue(item.agentPath)}`;
    case "imageView":
      return `IMAGE VIEW: ${stringValue(item.path)}`;
    case "contextCompaction":
      return "CONTEXT COMPACTED";
    case "hookPrompt":
      // Hook prompts can contain internal instructions that are not displayed
      // in either Codex or Claude's user-facing terminal transcript.
      return "";
    default: {
      const visible = { ...item };
      delete visible.id;
      delete visible.type;
      return `${type.toUpperCase()}\n${displayJson(visible)}`.trimEnd();
    }
  }
}

function renderThreadTranscript(result: ThreadReadResult): string {
  const turns = result.thread?.turns ?? [];
  const sections: string[] = [];
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    const items = (turn.items ?? [])
      .map(renderThreadItem)
      .filter(Boolean);
    const error = turn.error?.message ? `ERROR\n${turn.error.message}` : "";
    const body = [...items, error].filter(Boolean).join("\n\n");
    if (!body) continue;
    sections.push(
      [
        `── TURN ${index + 1} (${turn.status ?? "unknown"}) ──`,
        body,
      ].join("\n"),
    );
  }

  const transcript = sections.length > 0
    ? sections.join("\n\n")
    : "(no transcript yet)";
  return transcript;
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
  private restarting = false;
  private initialized = false;
  private processGeneration = 0;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private cwd: string;
  private model: string;
  private effort: string;
  private supportedReasoningEfforts: string[] = [];
  private readonly reasoningEffortsByModel = new Map<string, string[]>();
  private readonly recentEvents: string[] = [];
  private readonly liveCaptureItems = new Map<
    string,
    { label: string; text: string }
  >();

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
    this.stdoutBuffer = "";
    const generation = ++this.processGeneration;
    const child = spawn(this.options.executable, args, {
      cwd: this.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) =>
      this.handleStdout(chunk, generation)
    );
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) this.options.onDebug?.(`[codex] ${text}`);
    });
    child.on("error", (error) => {
      this.options.onError?.("Codex app-server process error", error);
    });
    child.on("exit", (code, signal) => {
      if (
        generation !== this.processGeneration ||
        this.child !== child
      ) {
        return;
      }
      // Invalidate any asynchronous server-request handler that was awaiting
      // chat input when this app-server generation exited.
      this.processGeneration += 1;
      this.child = null;
      this.initialized = false;
      this.threadId = null;
      this.activeTurnId = null;
      this.liveCaptureItems.clear();
      const error = new Error(
        `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      if (!this.restarting) {
        this.emit("exit", { code, signal, expected: this.stopping });
      }
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "compact_bot",
        title: "Compact Bot",
        version: "1.4.1",
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

    if (process.platform === "win32" || !child.pid) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const forceTimer = setTimeout(() => {
          this.terminateProcessTree(child, "SIGKILL");
          finish();
        }, STOP_TIMEOUT_MS);
        child.once("exit", () => {
          clearTimeout(forceTimer);
          finish();
        });
        this.terminateProcessTree(child, "SIGTERM");
      });
      return;
    }

    const processGroupId = child.pid;
    await new Promise<void>((resolve) => {
      let settled = false;
      let leaderExited =
        child.exitCode !== null || child.signalCode !== null;
      let forceSent = false;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(forceTimer);
        clearTimeout(hardTimer);
        resolve();
      };
      const groupGone = (): boolean =>
        !this.processGroupExists(processGroupId);
      const maybeFinish = (): void => {
        // `start()` checks this.child, so also wait for the leader's exit event
        // to run and clear the current generation before returning.
        if (leaderExited && groupGone()) finish();
      };

      child.once("exit", () => {
        leaderExited = true;
        maybeFinish();
      });
      const pollTimer = setInterval(maybeFinish, 25);
      const forceTimer = setTimeout(() => {
        forceSent = true;
        this.terminateProcessTree(child, "SIGKILL");
        maybeFinish();
      }, STOP_TIMEOUT_MS);
      // SIGKILL should reap the remaining group promptly, but never leave a
      // shutdown promise pending forever if the OS reports a lingering zombie.
      const hardTimer = setTimeout(() => {
        if (!forceSent) {
          this.terminateProcessTree(child, "SIGKILL");
        }
        finish();
      }, STOP_TIMEOUT_MS + 1_000);

      this.terminateProcessTree(child, "SIGTERM");
      maybeFinish();
    });
  }

  /**
   * End the current Compact Bot session before replacing its runtime.
   *
   * Unlike `stop()`, this abandons the persisted goal and subscription. Every
   * protocol cleanup step is best-effort, but the app-server process group is
   * always stopped so per-thread MCP children cannot retain realtime locks.
   */
  async closeSession(): Promise<void> {
    await this.enqueue(async () => {
      try {
        await this.cleanupCurrentThread();
      } finally {
        await this.stop();
      }
    });
  }

  async newSession(updates?: {
    model?: string;
    cwd?: string;
    effort?: string;
  }): Promise<void> {
    await this.enqueue(async () => {
      const nextModel = updates?.model ?? this.model;
      const nextCwd = updates?.cwd ?? this.cwd;
      const requestedEffort = updates?.effort ?? this.effort;
      const nextEffort = this.effortForModel(nextModel, requestedEffort);
      if (requestedEffort && !nextEffort) {
        this.options.onDebug?.(
          `${nextModel} does not advertise reasoning effort ${requestedEffort}; using the model default`,
        );
      }

      await this.cleanupCurrentThread();

      this.model = nextModel;
      this.cwd = nextCwd;
      this.effort = nextEffort;
      this.restarting = true;
      try {
        // Unsubscribe alone retains a thread (and its per-thread MCP child)
        // for a 30-minute grace period. Restarting the app-server process
        // releases the old MCP process group before a new thread is created.
        await this.stop();
        await this.start();
      } catch (error) {
        await this.stop().catch(() => {});
        this.restarting = false;
        this.emit("exit", { code: null, signal: null, expected: false });
        throw error;
      } finally {
        this.restarting = false;
      }
    });
  }

  async submitChannelMessage(
    source: "discord" | "slack",
    content: string,
    meta: Record<string, string>,
  ): Promise<CodexSubmissionResult> {
    return await this.submitText(formatChannelMessage(source, content, meta));
  }

  async submitText(text: string): Promise<CodexSubmissionResult> {
    return await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      const input = [{ type: "text", text }];
      if (this.activeTurnId) {
        const expectedTurnId = this.activeTurnId;
        try {
          await this.request("turn/steer", {
            threadId: this.threadId,
            input,
            expectedTurnId,
          });
          return { turnId: expectedTurnId, steered: true };
        } catch (error) {
          if (!isStaleTurnError(error)) throw error;
          // A completion notification can race an inbound message. If the
          // cached turn id is stale, retry once as a fresh turn instead of
          // silently dropping the user's message.
          this.options.onDebug?.(
            `Could not steer Codex turn ${this.activeTurnId}; retrying with turn/start: ${String(error)}`,
          );
          this.activeTurnId = null;
        }
      }

      const result = (await this.request("turn/start", {
        threadId: this.threadId,
        input,
        cwd: this.cwd,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      })) as TurnStartResult;
      const turnId = result.turn?.id;
      if (!turnId) throw new Error("turn/start returned no turn id");
      this.activeTurnId = turnId;
      return { turnId, steered: false };
    });
  }

  async compact(hint?: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      const normalizedHint = hint?.trim();
      if (normalizedHint) {
        // The app-server compact method has no native hint parameter. Inject
        // the hint into model-visible history first so the compactor can honor
        // the same intent as Claude Code's `/compact <hint>`.
        await this.request("thread/inject_items", {
          threadId: this.threadId,
          items: [{
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: `[Compact Bot compaction hint]\n${normalizedHint}`,
            }],
          }],
        });
      }
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

  async setGoal(
    args: string,
    source?: "discord" | "slack",
    meta?: Record<string, string>,
  ): Promise<void> {
    await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      const objective = args.trim();
      if (objective === "clear") {
        // Clearing a goal is control-plane state, not user conversation. Do
        // not leave a synthetic `/goal clear` message in model-visible history.
        await this.request("thread/goal/clear", { threadId: this.threadId });
        return;
      }
      if (source && meta) {
        await this.request("thread/inject_items", {
          threadId: this.threadId,
          items: [{
            type: "message",
            role: "user",
            content: [{
              type: "input_text",
              text: formatChannelMessage(source, `/goal ${args}`, meta),
            }],
          }],
        });
      }
      await this.request("thread/goal/set", {
        threadId: this.threadId,
        objective,
      });
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

  /**
   * Resolve the requested effort for a model using the fully paginated model
   * catalog. Unknown models retain the request; known-incompatible models use
   * Codex's default effort (the empty string).
   */
  effortForModel(model: string, requested: string): string {
    const supported = this.reasoningEffortsByModel.get(model);
    if (!requested || !supported || supported.length === 0) return requested;
    return supported.includes(requested) ? requested : "";
  }

  /**
   * Capture the current Codex transcript. The default mirrors Claude's
   * 50-line viewport; `all` returns the complete current-thread transcript.
   */
  async captureStatus(all = false): Promise<string> {
    const header = [
      "Compact Bot · Codex app-server",
      `thread: ${this.threadId ?? "(starting)"}`,
      `turn: ${this.activeTurnId ?? "(idle)"}`,
      `model: ${this.model || "(Codex default)"}`,
      `effort: ${this.effort || "(Codex default)"}`,
      `cwd: ${this.cwd}`,
    ].join("\n");
    const threadId = this.threadId;
    if (!threadId) return header;

    try {
      const result = (await this.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as ThreadReadResult;
      const transcript = renderThreadTranscript(result);
      const live = this.renderLiveCapture();
      const body = [
        transcript === "(no transcript yet)" && live ? "" : transcript,
        live,
      ]
        .filter(Boolean)
        .join("\n\n");
      const visible = all
        ? body
        : body.split("\n").slice(-CAPTURE_VIEWPORT_LINES).join("\n");
      return `${header}\n\n${visible}`.trimEnd();
    } catch (error) {
      this.options.onError?.("Could not read Codex transcript", error);
      const events = all ? this.recentEvents : this.recentEvents.slice(-12);
      const live = this.renderLiveCapture();
      return [
        header,
        "",
        "(transcript unavailable; showing lifecycle events)",
        ...events,
        ...(live ? ["", live] : []),
      ].join("\n").trimEnd();
    }
  }

  private async startThread(): Promise<void> {
    if (!this.initialized) throw new Error("Codex app-server is not initialized");
    this.activeTurnId = null;
    this.liveCaptureItems.clear();
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
    this.recentEvents.length = 0;
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

  private async cleanupCurrentThread(): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) return;

    // Clear a persisted goal before interrupting its current turn. Otherwise
    // Codex may schedule another automatic goal turn in the cleanup window.
    try {
      await this.request(
        "thread/goal/clear",
        { threadId },
        SESSION_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      this.options.onDebug?.(
        `Could not clear previous Codex goal: ${String(error)}`,
      );
    }

    const turnId = this.activeTurnId;
    if (turnId) {
      try {
        await this.request(
          "turn/interrupt",
          { threadId, turnId },
          SESSION_CLEANUP_TIMEOUT_MS,
        );
      } catch (error) {
        this.options.onDebug?.(
          `Could not interrupt previous Codex turn: ${String(error)}`,
        );
      }
    }

    try {
      await this.request(
        "thread/unsubscribe",
        { threadId },
        SESSION_CLEANUP_TIMEOUT_MS,
      );
    } catch (error) {
      this.options.onDebug?.(
        `Could not unsubscribe from previous Codex thread: ${String(error)}`,
      );
    }
  }

  private async refreshModelCapabilities(): Promise<void> {
    try {
      const models: NonNullable<ModelListResult["data"]> = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = (await this.request("model/list", {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        })) as ModelListResult;
        models.push(...(result.data ?? []));
        const nextCursor = result.nextCursor ?? null;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          cursor = null;
        } else {
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } while (cursor);

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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation);
    this.operationQueue = run.then(
      () => undefined,
      (error) => {
        this.options.onError?.("Codex operation failed", error);
      },
    );
    return run;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
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

  private respond(
    id: JsonRpcId,
    result: unknown,
    generation: number,
  ): void {
    if (generation !== this.processGeneration) return;
    this.send({ id, result });
  }

  private respondError(
    id: JsonRpcId,
    message: string,
    generation: number,
  ): void {
    if (generation !== this.processGeneration) return;
    this.send({ id, error: { code: -32601, message } });
  }

  private send(message: JsonRpcMessage): void {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private terminateProcessTree(
    child: ChildProcessWithoutNullStreams,
    signal: NodeJS.Signals,
  ): void {
    if (process.platform !== "win32" && child.pid) {
      if (this.terminateProcessGroup(child.pid, signal)) return;
    }
    try {
      child.kill(signal);
    } catch {
      // The process has already exited.
    }
  }

  private terminateProcessGroup(
    processGroupId: number,
    signal: NodeJS.Signals,
  ): boolean {
    try {
      process.kill(-processGroupId, signal);
      return true;
    } catch {
      // The leader may not have reached its detached process group yet, or the
      // complete group may already be gone.
      return false;
    }
  }

  private processGroupExists(processGroupId: number): boolean {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private handleStdout(chunk: string, generation: number): void {
    if (generation !== this.processGeneration) return;
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage, generation);
      } catch (error) {
        this.options.onError?.(`Invalid Codex app-server JSON: ${line.slice(0, 300)}`, error);
      }
    }
  }

  private handleMessage(message: JsonRpcMessage, generation: number): void {
    if (generation !== this.processGeneration) return;
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
      void this.handleServerRequest(message, generation);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params ?? {});
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const notificationThreadId =
      typeof params.threadId === "string" ? params.threadId : null;
    if (notificationThreadId && notificationThreadId !== this.threadId) return;

    if (method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (
        turn?.id &&
        this.activeTurnId &&
        turn.id !== this.activeTurnId
      ) {
        // `turn/start` returns the authoritative id before its notification is
        // necessarily delivered. A delayed notification from the previous
        // turn must not replace the newer active turn or erase its live
        // capture buffer.
        this.options.onDebug?.(
          `Ignoring stale start for Codex turn ${turn.id}; active turn is ${this.activeTurnId}`,
        );
      } else {
        this.activeTurnId = turn?.id ?? this.activeTurnId;
        this.liveCaptureItems.clear();
        this.recordEvent(`turn started: ${this.activeTurnId ?? "unknown"}`);
      }
    } else if (method === "turn/completed") {
      const turn = params.turn as {
        id?: string;
        status?: string;
        error?: { message?: string } | null;
      } | undefined;
      this.recordEvent(
        `turn ${turn?.status ?? "completed"}: ${turn?.id ?? this.activeTurnId ?? "unknown"}`,
      );
      if (turn?.error?.message) this.recordEvent(`error: ${turn.error.message}`);
      if (!turn?.id || turn.id === this.activeTurnId) {
        this.activeTurnId = null;
        this.liveCaptureItems.clear();
      } else {
        this.options.onDebug?.(
          `Ignoring stale completion for Codex turn ${turn.id}; active turn is ${this.activeTurnId ?? "none"}`,
        );
      }
    } else if (method === "item/completed") {
      const item = params.item as {
        id?: string;
        type?: string;
        tool?: string;
        status?: string;
      } | undefined;
      if (item?.id) this.clearLiveCaptureItem(item.id);
      if (item?.type && item.type !== "reasoning") {
        const detail = item.tool ? ` ${item.tool}` : "";
        this.recordEvent(`${item.type}${detail}${item.status ? `: ${item.status}` : ""}`);
      }
    } else if (
      method === "item/agentMessage/delta" ||
      method === "item/plan/delta" ||
      method === "item/commandExecution/outputDelta" ||
      method === "item/fileChange/outputDelta" ||
      method === "item/reasoning/summaryTextDelta"
    ) {
      const labels: Record<string, string> = {
        "item/agentMessage/delta": "ASSISTANT (live)",
        "item/plan/delta": "PLAN (live)",
        "item/commandExecution/outputDelta": "COMMAND OUTPUT (live)",
        "item/fileChange/outputDelta": "FILE CHANGE (live)",
        "item/reasoning/summaryTextDelta": "REASONING (live)",
      };
      this.recordLiveCaptureDelta(
        params,
        labels[method],
        typeof params.delta === "string" ? params.delta : "",
      );
    } else if (method === "item/mcpToolCall/progress") {
      this.recordLiveCaptureDelta(
        params,
        "MCP PROGRESS (live)",
        typeof params.message === "string" ? `${params.message}\n` : "",
      );
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

  private recordLiveCaptureDelta(
    params: Record<string, unknown>,
    label: string,
    delta: string,
  ): void {
    const turnId =
      typeof params.turnId === "string" ? params.turnId : undefined;
    const itemId =
      typeof params.itemId === "string" ? params.itemId : undefined;
    if (!delta || !turnId || !itemId || turnId !== this.activeTurnId) return;

    const key = `${itemId}:${label}`;
    const previous = this.liveCaptureItems.get(key);
    const text = `${previous?.text ?? ""}${delta}`.slice(-20_000);
    this.liveCaptureItems.set(key, { label, text });
    while (this.liveCaptureItems.size > 100) {
      const oldest = this.liveCaptureItems.keys().next().value;
      if (typeof oldest !== "string") break;
      this.liveCaptureItems.delete(oldest);
    }
  }

  private clearLiveCaptureItem(itemId: string): void {
    for (const key of this.liveCaptureItems.keys()) {
      if (key.startsWith(`${itemId}:`)) this.liveCaptureItems.delete(key);
    }
  }

  private renderLiveCapture(): string {
    const rendered = [...this.liveCaptureItems.values()]
      .map(({ label, text }) => `${label}\n${text}`.trimEnd())
      .filter(Boolean);
    if (rendered.length === 0 || !this.activeTurnId) return "";
    return [
      `── LIVE TURN ${this.activeTurnId} ──`,
      ...rendered,
    ].join("\n\n");
  }

  private async handleServerRequest(
    message: JsonRpcMessage,
    generation: number,
  ): Promise<void> {
    const id = message.id;
    const method = message.method;
    const params = message.params ?? {};
    if (id === undefined || !method) return;

    const requestThreadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    if (requestThreadId && requestThreadId !== this.threadId) {
      this.options.onDebug?.(
        `Declining stale Codex request ${method} for thread ${requestThreadId}`,
      );
      this.declineServerRequest(id, method, generation);
      return;
    }

    const requestContext = {
      threadId: requestThreadId,
      turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      itemId: typeof params.itemId === "string" ? params.itemId : undefined,
    };

    try {
      switch (method) {
        case "item/tool/requestUserInput": {
          const questions = Array.isArray(params.questions)
            ? (params.questions as Array<{
                id?: string;
                header?: string;
                question?: string;
                isOther?: boolean;
                isSecret?: boolean;
                options?: Array<{ label?: string; description?: string }> | null;
              }>)
            : [];
          if (questions.some((question) => question.isSecret === true)) {
            // Compact Bot's callbacks render questions in public chat
            // surfaces. Never solicit or echo secret input there.
            this.options.onDebug?.(
              "Declining Codex secret-input request on a public chat surface",
            );
            this.respond(id, { answers: {} }, generation);
            return;
          }
          const answers: Record<string, { answers: string[] }> = {};
          const requestDeadline =
            typeof params.autoResolutionMs === "number"
              ? Date.now() + Math.max(0, params.autoResolutionMs)
              : null;
          for (let index = 0; index < questions.length; index++) {
            const question = questions[index];
            const options = (question.options ?? []).map((option) => ({
              label: option.label ?? "",
              description: option.description ?? "",
            }));
            const remainingMs = requestDeadline === null
              ? null
              : Math.max(0, requestDeadline - Date.now());
            const uiQuestion: CodexQuestion = {
              ...requestContext,
              autoResolutionMs: remainingMs,
              // No selectable options means the only useful non-secret
              // response is free-form, even when an older server leaves
              // `isOther` at its default false.
              isOther:
                options.length === 0
                  ? true
                  : question.isOther ?? false,
              isSecret: question.isSecret ?? false,
              header: question.header || `질문 ${index + 1}/${questions.length}`,
              question: question.question ?? "",
              options,
            };
            let rawAnswer: string | null;
            if (remainingMs === null) {
              rawAnswer = await this.options.onQuestion(uiQuestion);
            } else if (remainingMs <= 0) {
              rawAnswer = null;
            } else {
              rawAnswer = await new Promise<string | null>((resolve, reject) => {
                const timer = setTimeout(() => resolve(null), remainingMs);
                this.options.onQuestion(uiQuestion).then(
                  (answer) => {
                    clearTimeout(timer);
                    resolve(answer);
                  },
                  (error) => {
                    clearTimeout(timer);
                    reject(error);
                  },
                );
              });
            }
            if (rawAnswer === null) {
              // Null is a whole-request cancellation/timeout sentinel. Do not
              // return partial answers for an already-expired prompt.
              this.respond(id, { answers: {} }, generation);
              return;
            }
            const answer = normalizeChoice(rawAnswer, options);
            answers[question.id ?? String(index)] = {
              answers: answer ? [answer] : [],
            };
          }
          this.respond(id, { answers }, generation);
          return;
        }

        case "item/commandExecution/requestApproval": {
          const command = String(params.command ?? "(명령 정보 없음)");
          const choices = commandApprovalChoices(params.availableDecisions);
          const options = choices.map(({ option }) => option);
          const fallbackDecision =
            choices.find(({ decision }) => decision === "decline")?.decision ??
            choices.find(({ decision }) => decision === "cancel")?.decision ??
            "decline";
          const details = [
            command,
            approvalDetail("위치", params.cwd),
            approvalDetail("이유", params.reason),
            approvalDetail("명령 작업", params.commandActions),
            approvalDetail("네트워크 승인 컨텍스트", params.networkApprovalContext),
            approvalDetail("추가 권한", params.additionalPermissions),
            approvalDetail("제안된 실행 규칙", params.proposedExecpolicyAmendment),
            approvalDetail(
              "제안된 네트워크 규칙",
              params.proposedNetworkPolicyAmendments,
            ),
          ].filter(Boolean).join("\n\n");
          const answer = normalizeChoice(
            await this.options.onQuestion({
              ...requestContext,
              isOther: false,
              header: "Codex 권한",
              question: `다음 명령 실행을 허용할까요?\n\n${details}`,
              options,
            }) ?? "",
            options,
          );
          const decision =
            choices.find(({ option }) => option.label === answer)?.decision ??
            fallbackDecision;
          this.respond(id, { decision }, generation);
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
              ...requestContext,
              isOther: false,
              header: "Codex 권한",
              question: `${reason}${root}`,
              options,
            }) ?? "",
            options,
          );
          const decision = answer === options[0].label
            ? "accept"
            : answer === options[1].label
              ? "acceptForSession"
              : "decline";
          this.respond(id, { decision }, generation);
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
              ...requestContext,
              isOther: false,
              header: "Codex 권한",
              question: [
                String(params.reason ?? "추가 권한 요청"),
                approvalDetail("위치", params.cwd),
                approvalDetail("환경", params.environmentId),
                approvalDetail("요청 권한", requested),
              ].filter(Boolean).join("\n\n"),
              options,
            }) ?? "",
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
          }, generation);
          return;
        }

        case "mcpServer/elicitation/request":
          // Compact Bot's own Discord/Slack MCP servers do not issue
          // elicitations. Decline third-party forms rather than hanging the
          // active turn with a UI shape we cannot render faithfully.
          this.respond(
            id,
            { action: "decline", content: null, _meta: null },
            generation,
          );
          return;

        default:
          this.respondError(
            id,
            `Unsupported app-server request: ${method}`,
            generation,
          );
      }
    } catch (error) {
      this.options.onError?.(`Failed to handle Codex server request: ${method}`, error);
      if (generation !== this.processGeneration) return;
      if (method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval") {
        this.respond(id, { decision: "decline" }, generation);
      } else if (method === "item/tool/requestUserInput") {
        this.respond(id, { answers: {} }, generation);
      } else if (method === "item/permissions/requestApproval") {
        this.respond(
          id,
          { permissions: {}, scope: "turn" },
          generation,
        );
      } else {
        this.respondError(
          id,
          `Compact Bot could not handle ${method}`,
          generation,
        );
      }
    }
  }

  private declineServerRequest(
    id: JsonRpcId,
    method: string,
    generation: number,
  ): void {
    if (method === "item/tool/requestUserInput") {
      this.respond(id, { answers: {} }, generation);
    } else if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.respond(id, { decision: "decline" }, generation);
    } else if (method === "item/permissions/requestApproval") {
      this.respond(
        id,
        { permissions: {}, scope: "turn" },
        generation,
      );
    } else if (method === "mcpServer/elicitation/request") {
      this.respond(
        id,
        { action: "decline", content: null, _meta: null },
        generation,
      );
    } else {
      this.respondError(id, `Stale app-server request: ${method}`, generation);
    }
  }

  private recordEvent(event: string): void {
    this.recentEvents.push(`[${new Date().toISOString()}] ${event}`);
    if (this.recentEvents.length > 200) this.recentEvents.splice(0, 50);
  }
}
