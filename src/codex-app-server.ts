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
import { COMPACT_BOT_VERSION } from "./version.js";

export type JsonRpcId = string | number;

export interface CodexMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  envVars: string[];
}

export interface CodexQuestion {
  /** App-server request id used to correlate resolution/cancellation. */
  requestId?: JsonRpcId;
  /**
   * Aborted when app-server reports `serverRequest/resolved` before the chat
   * surface answers. Consumers may use this to remove stale question UI.
   */
  signal?: AbortSignal;
  /** Whether only a configured platform operator may answer this request. */
  operatorOnly?: boolean;
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
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Runs while parsing the success response, before later notification lines
   * from the same stdout chunk can be dispatched.
   */
  onSuccess?: (value: unknown) => void;
}

interface NotificationWaiter {
  generation: number;
  label: string;
  predicate: (
    method: string,
    params: Record<string, unknown>,
  ) => boolean;
  resolve: (matched: boolean) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationBarrier {
  promise: Promise<void>;
  cancel: () => void;
}

interface ActiveServerRequest {
  generation: number;
  method: string;
  threadId?: string;
  controller: AbortController;
}

interface ThreadStartResult {
  thread?: {
    id?: string;
  };
  model?: string;
  cwd?: string;
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

interface ThreadTurn {
  id?: string;
  status?: string;
  error?: { message?: string } | null;
  items?: Array<Record<string, unknown>>;
}

interface ThreadTurnsListResult {
  data?: ThreadTurn[];
  nextCursor?: string | null;
}

const REQUEST_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 5_000;
const SESSION_CLEANUP_TIMEOUT_MS = 2_000;
const GOAL_START_TIMEOUT_MS = 15_000;
const COMPACTION_TIMEOUT_MS = 5 * 60_000;
const CAPTURE_VIEWPORT_LINES = 50;
const MAX_CAPTURE_HISTORY_LINES = 200;
const MAX_CAPTURE_BODY_CHARS = 512 * 1024;
const MAX_CAPTURE_EVENT_CHARS = 64 * 1024;
const THREAD_TURNS_PAGE_LIMIT = 50;
const MAX_CAPTURE_PAGE_COUNT = 100;
const MAX_APP_SERVER_JSON_LINE_CHARS = 16 * 1024 * 1024;
const MAX_PROTOCOL_ID_PREFIX_CHARS = 4 * 1024;
const MAX_COMPLETED_TURN_IDS = 256;
const SERVER_REQUEST_RESOLVED = Symbol("server-request-resolved");
const INTERRUPT_ABANDON_METHODS = new Set([
  "turn/start",
  "turn/steer",
  "thread/inject_items",
  "thread/compact/start",
  "thread/goal/set",
]);
const GOAL_CLEAR_ABANDON_METHODS = new Set([
  "thread/inject_items",
  "thread/compact/start",
  "thread/goal/set",
]);
const SESSION_REPLACEMENT_ABANDON_METHODS = new Set([
  ...INTERRUPT_ABANDON_METHODS,
  "thread/settings/update",
]);

interface DirectChildExitTarget {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
}

/**
 * Terminate a non-process-group child and report whether its exit was observed.
 *
 * Windows does not provide the POSIX group probe used by the main stop path.
 * Returning false after the hard deadline lets the caller fence that exact
 * generation before starting a replacement instead of racing a late exit.
 */
export function waitForDirectChildExit(
  child: DirectChildExitTarget,
  terminate: (signal: NodeJS.Signals) => void,
  stopTimeoutMs = STOP_TIMEOUT_MS,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(hardTimer);
      resolve(exited);
    };
    const forceTimer = setTimeout(
      () => terminate("SIGKILL"),
      stopTimeoutMs,
    );
    const hardTimer = setTimeout(() => {
      terminate("SIGKILL");
      finish(false);
    }, stopTimeoutMs + 1_000);
    child.once("exit", () => finish(true));
    terminate("SIGTERM");
  });
}

class CodexControlInterruptionError extends Error {
  constructor(
    message: string,
    readonly skipGoalRollback = false,
  ) {
    super(message);
    this.name = "CodexControlInterruptionError";
  }
}

class CodexRequestTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`Codex request timed out: ${method}`);
    this.name = "CodexRequestTimeoutError";
  }
}

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
 * Compact Bot configures only a secretless stdio proxy here. The wrapper owns
 * the real platform MCP child and injects its credentials through an inherited
 * fd, so neither app-server argv nor its environment contains platform
 * secrets. `approve` keeps reply/react tools from prompting on every call.
 */
export function buildCodexAppServerArgs(
  servers: CodexMcpServerConfig[],
): string[] {
  const args = [
    "app-server",
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
  ];
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
  // The wrapper resolves button clicks to their label before returning here.
  // Prefer an exact label over the legacy numeric-index shorthand so labels
  // such as "1" or "2" are not interpreted a second time as a different row.
  if (options.some((option) => option.label === trimmed)) return trimmed;
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
    /turn.+(?:not active|no longer active|inactive|completed|not found)/i.test(
      message,
    ) ||
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

const CAPTURE_TRUNCATION_NOTICE = "… older transcript content omitted …";

function appendBoundedCaptureText(
  current: string,
  addition: string,
  maxChars = MAX_CAPTURE_BODY_CHARS,
): string {
  if (!addition) return current;
  const combined = current ? `${current}\n\n${addition}` : addition;
  if (combined.length <= maxChars) return combined;
  const remaining = Math.max(
    0,
    maxChars - CAPTURE_TRUNCATION_NOTICE.length - 1,
  );
  if (remaining === 0) return CAPTURE_TRUNCATION_NOTICE.slice(0, maxChars);
  return `${CAPTURE_TRUNCATION_NOTICE}\n${combined.slice(-remaining)}`;
}

function renderThreadTurn(
  turn: ThreadTurn,
  maxChars = MAX_CAPTURE_BODY_CHARS,
): string {
  const header = `── TURN ${turn.id ?? "unknown"} (${turn.status ?? "unknown"}) ──`;
  const bodyLimit = Math.max(0, maxChars - header.length - 1);
  let body = "";
  for (const item of turn.items ?? []) {
    body = appendBoundedCaptureText(
      body,
      renderThreadItem(item),
      bodyLimit,
    );
  }
  if (turn.error?.message) {
    body = appendBoundedCaptureText(
      body,
      `ERROR\n${turn.error.message}`,
      bodyLimit,
    );
  }
  return body ? `${header}\n${body}` : "";
}

function boundCaptureEntry(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const notice = "\n… event content truncated …\n";
  if (notice.length >= maxChars) return notice.slice(0, maxChars);
  const remaining = maxChars - notice.length;
  const leading = Math.ceil(remaining / 2);
  return `${value.slice(0, leading)}${notice}${value.slice(-(remaining - leading))}`;
}

function jsonRpcIdFromProtocolPrefix(prefix: string): JsonRpcId | undefined {
  const match =
    /^\s*\{\s*"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?)/.exec(
      prefix,
    );
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]) as unknown;
    return typeof value === "string" || typeof value === "number"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function isMethodNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\(-32601\)|method not found/i.test(message);
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
  private discardedProtocolLine:
    | { length: number; requestId?: JsonRpcId }
    | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private operationQueue: Promise<void> = Promise.resolve();
  /** Recovery operations bypass the normal lifecycle queue but remain ordered. */
  private controlQueue: Promise<void> = Promise.resolve();
  /** Queued normal work from an old session must never run on its replacement. */
  private operationEpoch = 0;
  private stopping = false;
  private restarting = false;
  private initialized = false;
  private processGeneration = 0;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private goalActive = false;
  /** Monotonic terminal-goal notification fence within the current thread. */
  private goalTerminalRevision = 0;
  /** Advances when no immediate automatic goal turn is guaranteed. */
  private goalBarrierReleaseRevision = 0;
  /** Active turn that must finish before the accepted goal can start a turn. */
  private goalPendingAfterTurnId: string | null = null;
  private readonly completedTurnIds = new Set<string>();
  private readonly activeServerRequests = new Map<
    JsonRpcId,
    ActiveServerRequest
  >();
  private cwd: string;
  private model: string;
  private effort: string;
  private supportedReasoningEfforts: string[] = [];
  private readonly reasoningEffortsByModel = new Map<string, string[]>();
  private readonly recentEvents: string[] = [];
  /** Bounded notification-derived transcript used by ordinary `/capture`. */
  private readonly recentCaptureLines: string[] = [];
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

  get hasActiveGoal(): boolean {
    return this.goalActive;
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
    this.discardedProtocolLine = null;
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
      this.goalActive = false;
      this.goalPendingAfterTurnId = null;
      this.completedTurnIds.clear();
      this.abortActiveServerRequests();
      this.liveCaptureItems.clear();
      this.recentCaptureLines.length = 0;
      const error = new Error(
        `Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.rejectNotificationWaiters(error);
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
        version: COMPACT_BOT_VERSION,
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
      const exited = await waitForDirectChildExit(
        child,
        (signal) => this.terminateProcessTree(child, signal),
      );
      if (!exited) {
        this.detachUnresponsiveChild(
          child,
          new Error(
            "Codex app-server did not exit after forced termination",
          ),
        );
      }
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
        if (this.child === child && (!leaderExited || !groupGone())) {
          this.detachUnresponsiveChild(
            child,
            new Error(
              "Codex app-server process group did not exit after forced termination",
            ),
          );
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
  closeSession(): Promise<void> {
    this.emit("closing", { reason: "session closed" });
    this.operationEpoch += 1;
    return this.enqueueControl(async () => {
      this.abandonInFlightOperations(
        new CodexControlInterruptionError(
          "Codex session closed while an operation was pending",
          true,
        ),
        true,
        SESSION_REPLACEMENT_ABANDON_METHODS,
      );
      try {
        await this.cleanupCurrentThread();
      } finally {
        await this.stop();
      }
    });
  }

  newSession(updates?: {
    model?: string;
    cwd?: string;
    effort?: string;
  }): Promise<void> {
    this.emit("resetting", { reason: "new session" });
    this.operationEpoch += 1;
    return this.enqueueControl(async () => {
      this.abandonInFlightOperations(
        new CodexControlInterruptionError(
          "Codex session restarted while an operation was pending",
          true,
        ),
        true,
        SESSION_REPLACEMENT_ABANDON_METHODS,
      );
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
        this.emit("reset", { reason: "new session" });
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
    onAccepted?: (submission: CodexSubmissionResult) => void,
  ): Promise<CodexSubmissionResult> {
    return await this.submitText(
      formatChannelMessage(source, content, meta),
      onAccepted,
    );
  }

  async submitText(
    text: string,
    onAccepted?: (submission: CodexSubmissionResult) => void,
  ): Promise<CodexSubmissionResult> {
    try {
      return await this.enqueue(async () => {
        if (!this.threadId) throw new Error("Codex thread is not ready");
        await this.awaitDeferredGoalStartIfNeeded();
        const input = [{ type: "text", text }];
        if (this.activeTurnId) {
          const expectedTurnId = this.activeTurnId;
          try {
            await this.request(
              "turn/steer",
              {
                threadId: this.threadId,
                input,
                expectedTurnId,
              },
              REQUEST_TIMEOUT_MS,
              () => {
                onAccepted?.({ turnId: expectedTurnId, steered: true });
              },
            );
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
            await this.awaitDeferredGoalStartIfNeeded();
            if (this.activeTurnId) {
              const recoveredTurnId = this.activeTurnId;
              try {
                await this.request(
                  "turn/steer",
                  {
                    threadId: this.threadId,
                    input,
                    expectedTurnId: recoveredTurnId,
                  },
                  REQUEST_TIMEOUT_MS,
                  () => {
                    onAccepted?.({
                      turnId: recoveredTurnId,
                      steered: true,
                    });
                  },
                );
                return { turnId: recoveredTurnId, steered: true };
              } catch (recoveredError) {
                if (!isStaleTurnError(recoveredError)) throw recoveredError;
                this.activeTurnId = null;
              }
            }
          }
        }

        const result = (await this.request(
          "turn/start",
          {
            threadId: this.threadId,
            input,
            cwd: this.cwd,
            ...(this.model ? { model: this.model } : {}),
            ...(this.effort ? { effort: this.effort } : {}),
          },
          REQUEST_TIMEOUT_MS,
          (value) => {
            const acceptedTurnId = (value as TurnStartResult).turn?.id;
            if (acceptedTurnId) {
              onAccepted?.({ turnId: acceptedTurnId, steered: false });
            }
          },
        )) as TurnStartResult;
        const turnId = result.turn?.id;
        if (!turnId) throw new Error("turn/start returned no turn id");
        if (this.completedTurnIds.has(turnId)) {
          // The completion notification can be delivered before the response to
          // turn/start. Never resurrect a turn that app-server already finished.
          if (this.activeTurnId === turnId) this.activeTurnId = null;
          this.options.onDebug?.(
            `Codex turn ${turnId} completed before turn/start returned`,
          );
        } else {
          this.activeTurnId = turnId;
        }
        return { turnId, steered: false };
      });
    } catch (error) {
      const timedOutTurnMutation =
        error instanceof CodexRequestTimeoutError &&
        ["turn/start", "turn/steer"].includes(error.method);
      const timedOutDeferredGoal =
        (
          error instanceof Error &&
          error.message ===
            "Timed out waiting for Codex first automatic goal turn"
        );
      if (timedOutTurnMutation || timedOutDeferredGoal) {
        this.operationEpoch += 1;
        await this.enqueueControl(
          () =>
            this.replaceRuntimeAfterUnsafeControl(
              timedOutTurnMutation
                ? `timed-out ${
                  (error as CodexRequestTimeoutError).method
                }`
                : "timed-out deferred goal turn",
            ),
        );
      }
      throw error;
    }
  }

  async compact(hint?: string): Promise<void> {
    try {
      await this.enqueue(async () => {
        if (!this.threadId) throw new Error("Codex thread is not ready");
        if (this.goalActive || this.goalPendingAfterTurnId) {
          throw new Error(
            "활성 Codex goal이 있는 동안에는 context compaction을 시작할 수 없습니다",
          );
        }
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
        const barrier = this.createCompactionBarrier(this.threadId);
        try {
          await Promise.all([
            this.request("thread/compact/start", { threadId: this.threadId }),
            barrier.promise,
          ]);
          // The empty response only acknowledges that compaction was scheduled.
          // 0.146 interrupts the current turn and runs a separate, non-steerable
          // contextCompaction turn afterwards. Keep later chat input queued until
          // that lifecycle is fully complete.
        } catch (error) {
          barrier.cancel();
          throw error;
        }
      });
    } catch (error) {
      if (
        (
          error instanceof CodexRequestTimeoutError &&
          (
            error.method === "thread/compact/start" ||
            error.method === "thread/inject_items"
          )
        ) ||
        (
          error instanceof Error &&
          error.message ===
            "Timed out waiting for Codex context compaction turn"
        )
      ) {
        this.operationEpoch += 1;
        await this.enqueueControl(
          () =>
            this.replaceRuntimeAfterUnsafeControl(
              "timed-out context compaction",
            ),
        );
      }
      throw error;
    }
  }

  interrupt(): Promise<void> {
    return this.enqueueControl(async () => {
      const threadId = this.threadId;
      const turnId = this.activeTurnId;
      let requiresRuntimeReset =
        this.hasCompactionBarrier() ||
        this.hasGoalStartBarrier() ||
        this.goalPendingAfterTurnId !== null ||
        this.activeServerRequests.size > 0 ||
        this.hasPendingMethod([
          "turn/start",
          "turn/steer",
          "thread/inject_items",
          "thread/compact/start",
          "thread/goal/set",
        ]);
      const resetPlannedBeforeInterrupt = requiresRuntimeReset;
      if (requiresRuntimeReset) this.operationEpoch += 1;
      this.abandonInFlightOperations(
        new CodexControlInterruptionError(
          "Codex operation interrupted by control command",
        ),
        false,
        INTERRUPT_ABANDON_METHODS,
      );
      let interruptError: unknown = null;
      const completionBarrier =
        threadId && turnId
          ? this.createTurnCompletionBarrier(threadId, turnId)
          : null;
      if (threadId && turnId) {
        try {
          await Promise.all([
            this.request(
              "turn/interrupt",
              {
                threadId,
                turnId,
              },
              SESSION_CLEANUP_TIMEOUT_MS,
            ),
            completionBarrier?.promise ?? Promise.resolve(),
          ]);
        } catch (error) {
          completionBarrier?.cancel();
          interruptError = error;
          requiresRuntimeReset = true;
        }
      }
      if (requiresRuntimeReset && !resetPlannedBeforeInterrupt) {
        // The reset became necessary only after interrupt/completion failed.
        this.operationEpoch += 1;
      }
      if (requiresRuntimeReset) {
        // App-server has no cancellation API for an accepted compaction or a
        // request whose turn/goal id never arrived. Replacing the process is
        // the only way to prove that a late mutation cannot cross the control
        // boundary and race newly queued input.
        await this.replaceRuntimeAfterUnsafeControl("interrupt");
        return;
      }
      if (interruptError) throw interruptError;
    });
  }

  async setGoal(
    args: string,
    source?: "discord" | "slack",
    meta?: Record<string, string>,
    onAccepted?: () => void,
  ): Promise<void> {
    const objective = args.trim();
    if (objective === "clear") {
      await this.enqueueControl(async () => {
        if (!this.threadId) throw new Error("Codex thread is not ready");
        const threadId = this.threadId;
        let requiresRuntimeReset =
          this.hasCompactionBarrier() ||
          this.hasGoalStartBarrier() ||
          this.goalPendingAfterTurnId !== null ||
          this.activeServerRequests.size > 0 ||
          this.hasPendingMethod([
            "thread/inject_items",
            "thread/compact/start",
            "thread/goal/set",
          ]);
        if (requiresRuntimeReset) this.operationEpoch += 1;
        this.abandonInFlightOperations(
          new CodexControlInterruptionError(
            "Codex goal cleared while an operation was pending",
            true,
          ),
          false,
          GOAL_CLEAR_ABANDON_METHODS,
        );
        // Clearing a goal is control-plane state, not user conversation. Do
        // not leave a synthetic `/goal clear` message in model-visible history.
        let clearError: unknown = null;
        try {
          await this.request(
            "thread/goal/clear",
            { threadId },
            SESSION_CLEANUP_TIMEOUT_MS,
          );
        } catch (error) {
          clearError = error;
        }
        if (clearError && !requiresRuntimeReset) {
          this.operationEpoch += 1;
          requiresRuntimeReset = true;
        }
        if (!clearError) this.goalActive = false;
        if (requiresRuntimeReset) {
          await this.replaceRuntimeAfterUnsafeControl("goal clear");
          return;
        }
        if (clearError) throw clearError;
      });
      return;
    }
    await this.enqueue(async () => {
      if (!this.threadId) throw new Error("Codex thread is not ready");
      if (source && meta) {
        try {
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
        } catch (error) {
          if (
            error instanceof CodexRequestTimeoutError &&
            error.method === "thread/inject_items"
          ) {
            this.operationEpoch += 1;
            await this.enqueueControl(
              () =>
                this.replaceRuntimeAfterUnsafeControl(
                  "timed-out goal context injection",
                ),
            );
          }
          throw error;
        }
      }
      // An idle thread starts its first automatic goal turn asynchronously.
      // The goal/set response can arrive before turn/started, so keep the
      // operation queue closed until that authoritative id is installed.
      const previousTurnId = this.activeTurnId;
      const goalTerminalRevision = this.goalTerminalRevision;
      const goalBarrierReleaseRevision = this.goalBarrierReleaseRevision;
      this.goalPendingAfterTurnId = null;
      const barrier = this.createGoalStartBarrier(
        this.threadId,
        previousTurnId,
      );
      let goalAccepted = false;
      try {
        await this.request(
          "thread/goal/set",
          {
            threadId: this.threadId,
            objective,
          },
          REQUEST_TIMEOUT_MS,
          () => {
            goalAccepted = true;
            // A cleared/complete notification can precede the response in the
            // same stdout chunk. Do not resurrect that goal or its wrapper
            // owner after the terminal lifecycle is already authoritative.
            if (this.goalTerminalRevision === goalTerminalRevision) {
              this.goalActive = true;
              onAccepted?.();
            }
          },
        );
        if (
          goalAccepted &&
          this.goalActive &&
          previousTurnId &&
          this.activeTurnId === previousTurnId &&
          this.goalBarrierReleaseRevision === goalBarrierReleaseRevision
        ) {
          // The existing turn may legitimately keep running for much longer
          // than the idle-start timeout. Let same-owner input continue steering
          // it, then gate the first post-completion input until the automatic
          // goal turn (or a stable no-turn goal status) becomes authoritative.
          barrier.cancel();
          this.goalPendingAfterTurnId = previousTurnId;
          return;
        }
        await barrier.promise;
      } catch (error) {
        barrier?.cancel();
        if (
          !goalAccepted &&
          error instanceof CodexRequestTimeoutError &&
          error.method === "thread/goal/set"
        ) {
          // A timed-out mutation has an unknown server-side outcome. Clear it
          // best-effort, then replace the process. A clear acknowledgement is
          // not a sufficient ordering proof if the timed-out goal/set handler
          // can still commit afterwards.
          let rollbackError: unknown = null;
          try {
            await this.request(
              "thread/goal/clear",
              { threadId: this.threadId },
              SESSION_CLEANUP_TIMEOUT_MS,
            );
            this.goalActive = false;
          } catch (caught) {
            rollbackError = caught;
          }
          this.operationEpoch += 1;
          await this.enqueueControl(
            () =>
              this.replaceRuntimeAfterUnsafeControl(
                "timed-out goal mutation",
              ),
          );
          if (rollbackError) {
            throw new Error(
              `${error.message}; Codex goal timeout recovery required a runtime reset: ${
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError)
              }`,
              { cause: error },
            );
          }
        }
        if (
          goalAccepted &&
          !(
            error instanceof CodexControlInterruptionError &&
            error.skipGoalRollback
          )
        ) {
          let rollbackError: unknown = null;
          try {
            await this.request(
              "thread/goal/clear",
              { threadId: this.threadId },
              SESSION_CLEANUP_TIMEOUT_MS,
            );
            this.goalActive = false;
          } catch (caught) {
            rollbackError = caught;
          }
          const goalStartTimedOut =
            error instanceof Error &&
            error.message ===
              "Timed out waiting for Codex first automatic goal turn";
          if (rollbackError || goalStartTimedOut) {
            this.operationEpoch += 1;
            await this.enqueueControl(
              () =>
                this.replaceRuntimeAfterUnsafeControl(
                  goalStartTimedOut
                    ? "timed-out automatic goal start"
                    : "failed goal rollback",
                ),
            );
          }
          if (rollbackError) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}; ` +
                `Codex goal rollback failed: ${
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError)
                }`,
              { cause: error },
            );
          }
        }
        throw error;
      }
    });
  }

  /** Persist the reasoning effort used by subsequent explicit and goal turns. */
  async setEffort(value: string): Promise<void> {
    const normalized = normalizeReasoningEffort(value);
    if (!normalized) {
      throw new Error(`지원하지 않는 reasoning effort: ${value}`);
    }
    try {
      await this.enqueue(async () => {
        if (!this.threadId) throw new Error("Codex thread is not ready");
        if (
          this.reasoningEffortsByModel.has(this.model) &&
          !this.supportedReasoningEfforts.includes(normalized)
        ) {
          throw new Error(
            `${this.model || "현재 모델"}은 ${normalized} effort를 지원하지 않습니다`,
          );
        }
        await this.request("thread/settings/update", {
          threadId: this.threadId,
          effort: normalized,
        });
        // Update only after Codex accepts the mutation. A matching
        // thread/settings/updated notification may have already done this.
        this.effort = normalized;
        this.recordEvent(`reasoning effort changed: ${normalized}`);
      });
    } catch (error) {
      if (
        error instanceof CodexRequestTimeoutError &&
        error.method === "thread/settings/update"
      ) {
        this.operationEpoch += 1;
        await this.enqueueControl(
          () =>
            this.replaceRuntimeAfterUnsafeControl(
              "timed-out thread settings mutation",
            ),
        );
      }
      throw error;
    }
  }

  /**
   * Resolve the requested effort for a model using the fully paginated model
   * catalog. Unknown models retain the request; known-incompatible models use
   * Codex's default effort (the empty string).
   */
  effortForModel(model: string, requested: string): string {
    const supported = this.reasoningEffortsByModel.get(model);
    if (!requested || !this.reasoningEffortsByModel.has(model)) return requested;
    return supported?.includes(requested) ? requested : "";
  }

  /**
   * Capture the current Codex transcript. The default mirrors Claude's
   * 50-line viewport; `all` reads the newest available current-thread history
   * through Codex's paginated experimental API, bounded to the capture budget.
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

    if (!all) {
      const live = this.renderLiveCapture();
      const recent = this.recentCaptureLines
        .slice(-CAPTURE_VIEWPORT_LINES)
        .join("\n");
      const body = appendBoundedCaptureText(
        recent,
        live,
        MAX_CAPTURE_BODY_CHARS,
      ) || "(no recent transcript items)";
      return `${header}\n\n${body}`.trimEnd();
    }

    try {
      const transcript = await this.readPaginatedThreadTranscript(threadId);
      const live = this.renderLiveCapture();
      const body = appendBoundedCaptureText(
        transcript === "(no transcript yet)" && live ? "" : transcript,
        live,
        MAX_CAPTURE_BODY_CHARS,
      );
      return `${header}\n\n${body}`.trimEnd();
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        this.options.onDebug?.(
          "Codex thread/turns/list is unavailable; using the bounded notification cache",
        );
      } else {
        this.options.onError?.("Could not read Codex transcript", error);
      }
      return this.renderCaptureFallback(header);
    }
  }

  private async readPaginatedThreadTranscript(
    threadId: string,
  ): Promise<string> {
    let cursor: string | undefined;
    let transcript = "";
    const seenCursors = new Set<string>();

    for (let page = 0; page < MAX_CAPTURE_PAGE_COUNT; page++) {
      const result = (await this.request("thread/turns/list", {
        threadId,
        ...(cursor ? { cursor } : {}),
        limit: THREAD_TURNS_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      })) as ThreadTurnsListResult;
      const turns = Array.isArray(result.data) ? result.data : [];
      let reachedBudget = false;

      // The API returns newest-first. Prepending each successively older turn
      // preserves terminal transcript order while keeping the newest suffix
      // when the bounded helper has to truncate.
      for (const turn of turns) {
        if (!turn || typeof turn !== "object") continue;
        const section = renderThreadTurn(turn, MAX_CAPTURE_BODY_CHARS);
        if (!section) continue;
        const wouldExceed =
          section.length +
            (transcript ? 2 : 0) +
            transcript.length >
          MAX_CAPTURE_BODY_CHARS;
        transcript = appendBoundedCaptureText(
          section,
          transcript,
          MAX_CAPTURE_BODY_CHARS,
        );
        if (wouldExceed || transcript.length >= MAX_CAPTURE_BODY_CHARS) {
          reachedBudget = true;
          break;
        }
      }
      if (reachedBudget) break;

      const nextCursor =
        typeof result.nextCursor === "string" && result.nextCursor
          ? result.nextCursor
          : null;
      if (!nextCursor) break;
      if (seenCursors.has(nextCursor)) {
        this.options.onDebug?.(
          `Codex thread/turns/list repeated cursor ${nextCursor}; stopping capture pagination`,
        );
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return transcript || "(no transcript yet)";
  }

  private renderCaptureFallback(header: string): string {
    const marker =
      "(transcript unavailable; showing bounded notification history)";
    const cacheBudget = Math.max(
      0,
      MAX_CAPTURE_BODY_CHARS - marker.length - 2,
    );
    let cache = "";
    cache = appendBoundedCaptureText(
      cache,
      this.recentEvents.join("\n"),
      cacheBudget,
    );
    cache = appendBoundedCaptureText(
      cache,
      this.recentCaptureLines.join("\n"),
      cacheBudget,
    );
    cache = appendBoundedCaptureText(
      cache,
      this.renderLiveCapture(),
      cacheBudget,
    );
    const body = cache ? `${marker}\n\n${cache}` : marker;
    return `${header}\n\n${body}`.trimEnd();
  }

  private async startThread(): Promise<void> {
    if (!this.initialized) throw new Error("Codex app-server is not initialized");
    this.activeTurnId = null;
    this.goalActive = false;
    this.goalPendingAfterTurnId = null;
    this.completedTurnIds.clear();
    this.abortActiveServerRequests();
    this.liveCaptureItems.clear();
    this.recentCaptureLines.length = 0;
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
    } else {
      // Do not inherit a user-level full-access policy into a chat-driven
      // agent. CONFIG_HOME is outside the workspace and contains platform
      // credentials; the explicit sandbox keeps it unreadable by default.
      params.sandbox = "workspace-write";
    }

    const result = (await this.request("thread/start", params)) as ThreadStartResult;
    const threadId = result.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    this.threadId = threadId;
    this.recentEvents.length = 0;
    if (typeof result.model === "string") this.model = result.model;
    if (typeof result.cwd === "string") this.cwd = result.cwd;
    if (Object.prototype.hasOwnProperty.call(result, "reasoningEffort")) {
      this.effort =
        typeof result.reasoningEffort === "string"
          ? result.reasoningEffort
          : "";
    }
    await this.refreshModelCapabilities();
    this.recordEvent(`thread started: ${threadId}`);
    this.emit("thread", this.stateSnapshot());
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
      this.goalActive = false;
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
    const generation = this.processGeneration;
    try {
      const models: NonNullable<ModelListResult["data"]> = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      do {
        const result = (await this.request("model/list", {
          includeHidden: true,
          ...(cursor ? { cursor } : {}),
        })) as ModelListResult;
        if (generation !== this.processGeneration) return;
        models.push(...(result.data ?? []));
        const nextCursor = result.nextCursor ?? null;
        if (!nextCursor || seenCursors.has(nextCursor)) {
          cursor = null;
        } else {
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } while (cursor);

      if (generation !== this.processGeneration) return;
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
      this.updateSupportedEffortsFromCache();
    } catch (error) {
      if (generation !== this.processGeneration) return;
      if (error instanceof CodexControlInterruptionError) {
        // A priority control command may abandon the background model/list
        // request. Keep the last authoritative cache until the replacement
        // thread refreshes it instead of treating cancellation as an old
        // app-server that lacks model/list.
        return;
      }
      // Older app-server versions may not expose model/list. Effort still
      // works through turn/start; only model-specific command validation is
      // unavailable in that case.
      this.reasoningEffortsByModel.clear();
      this.supportedReasoningEfforts = [];
      this.options.onDebug?.(
        `Could not load Codex reasoning efforts: ${String(error)}`,
      );
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const epoch = this.operationEpoch;
    const run = this.operationQueue.then(async () => {
      // A recovery command that arrived behind this work has priority. Waiting
      // for the current control tail prevents newly-unblocked normal work from
      // racing an interrupt or session replacement.
      await this.controlQueue;
      if (epoch !== this.operationEpoch) {
        throw new Error(
          "Codex session changed before the queued operation could run",
        );
      }
      return await operation();
    });
    this.operationQueue = run.then(
      () => undefined,
      (error) => {
        this.options.onError?.("Codex operation failed", error);
      },
    );
    return run;
  }

  private enqueueControl<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.controlQueue.then(operation);
    this.controlQueue = run.then(
      () => undefined,
      (error) => {
        this.options.onError?.("Codex control operation failed", error);
      },
    );
    return run;
  }

  private hasPendingMethod(methods: string[]): boolean {
    const candidates = new Set(methods);
    return [...this.pending.values()].some((request) =>
      candidates.has(request.method)
    );
  }

  private hasCompactionBarrier(): boolean {
    return [...this.notificationWaiters].some(
      (waiter) => waiter.label === "context compaction turn",
    );
  }

  private hasGoalStartBarrier(): boolean {
    return [...this.notificationWaiters].some(
      (waiter) => waiter.label === "first automatic goal turn",
    );
  }

  private async awaitDeferredGoalStartIfNeeded(): Promise<void> {
    const previousTurnId = this.goalPendingAfterTurnId;
    if (!previousTurnId) return;
    if (this.activeTurnId === previousTurnId) return;
    if (this.activeTurnId) {
      this.goalPendingAfterTurnId = null;
      return;
    }
    if (!this.threadId) throw new Error("Codex thread is not ready");

    const barrier = this.createGoalStartBarrier(
      this.threadId,
      previousTurnId,
    );
    try {
      await barrier.promise;
    } finally {
      if (this.goalPendingAfterTurnId === previousTurnId) {
        this.goalPendingAfterTurnId = null;
      }
    }
  }

  private async replaceRuntimeAfterUnsafeControl(reason: string): Promise<void> {
    this.options.onDebug?.(
      `Replacing Codex app-server after unsafe ${reason} recovery`,
    );
    this.emit("resetting", { reason });
    this.restarting = true;
    try {
      await this.stop();
      await this.start();
      this.emit("reset", { reason });
    } catch (error) {
      await this.stop().catch(() => {});
      this.restarting = false;
      this.emit("exit", { code: null, signal: null, expected: false });
      throw error;
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Release lifecycle barriers and request promises owned by normal work.
   *
   * JSON-RPC has no generic client-side cancellation for these calls. Removing
   * them from `pending` makes a late response harmless while allowing a
   * recovery request to use the same live app-server immediately.
   */
  private abandonInFlightOperations(
    error: Error,
    abortServerRequests = false,
    pendingMethods: ReadonlySet<string> | "all" = "all",
  ): void {
    this.rejectNotificationWaiters(error);
    for (const [id, request] of this.pending) {
      if (
        pendingMethods !== "all" &&
        !pendingMethods.has(request.method)
      ) {
        continue;
      }
      clearTimeout(request.timer);
      request.reject(error);
      this.pending.delete(id);
    }
    if (abortServerRequests) this.abortActiveServerRequests();
  }

  private createGoalStartBarrier(
    threadId: string,
    previousTurnId: string | null,
  ): NotificationBarrier {
    return this.createNotificationBarrier(
      "first automatic goal turn",
      GOAL_START_TIMEOUT_MS,
      (method, params) => {
        if (params.threadId !== threadId) return false;
        if (method === "turn/started") {
          const turnId =
            typeof (params.turn as { id?: unknown } | undefined)?.id === "string"
              ? (params.turn as { id: string }).id
              : null;
          return (
            turnId !== null &&
            turnId !== previousTurnId &&
            !this.completedTurnIds.has(turnId)
          );
        }
        if (method === "thread/goal/cleared") {
          return true;
        }
        if (method === "thread/goal/updated") {
          const status =
            typeof (params.goal as { status?: unknown } | undefined)?.status ===
                "string"
              ? (params.goal as { status: string }).status
              : "";
          if (
            [
              "complete",
              "completed",
              "paused",
              "blocked",
              "usageLimited",
              "budgetLimited",
            ]
              .includes(status)
          ) {
            // These are stable goal states with no guaranteed immediate turn.
            // Releasing the queue is safe; paused/limited goals remain owned
            // and can later resume.
            return true;
          }
          if (["failed", "cancelled", "canceled"].includes(status)) {
            throw new Error(
              `Codex goal ${status} before its first automatic turn`,
            );
          }
        }
        return false;
      },
    );
  }

  private createCompactionBarrier(threadId: string): NotificationBarrier {
    let compactionTurnId: string | null = null;
    return this.createNotificationBarrier(
      "context compaction turn",
      COMPACTION_TIMEOUT_MS,
      (method, params) => {
        if (params.threadId !== threadId) return false;
        const notificationTurnId =
          typeof params.turnId === "string" ? params.turnId : null;
        const item =
          params.item && typeof params.item === "object"
            ? params.item as Record<string, unknown>
            : null;
        if (
          (method === "item/started" || method === "item/completed") &&
          item?.type === "contextCompaction" &&
          notificationTurnId
        ) {
          compactionTurnId = notificationTurnId;
          return false;
        }
        if (method === "thread/compacted" && notificationTurnId) {
          compactionTurnId = notificationTurnId;
          return false;
        }
        if (method !== "turn/completed" || !compactionTurnId) return false;
        const turn =
          params.turn && typeof params.turn === "object"
            ? params.turn as Record<string, unknown>
            : {};
        if (turn.id !== compactionTurnId) return false;
        if (turn.status !== "completed") {
          const detail =
            turn.error && typeof turn.error === "object" &&
                typeof (turn.error as Record<string, unknown>).message === "string"
              ? `: ${(turn.error as Record<string, unknown>).message}`
              : "";
          throw new Error(
            `Codex context compaction ${String(turn.status ?? "failed")}${detail}`,
          );
        }
        return true;
      },
    );
  }

  private createTurnCompletionBarrier(
    threadId: string,
    turnId: string,
  ): NotificationBarrier {
    return this.createNotificationBarrier(
      `turn ${turnId} completion after interrupt`,
      SESSION_CLEANUP_TIMEOUT_MS,
      (method, params) => {
        if (method !== "turn/completed" || params.threadId !== threadId) {
          return false;
        }
        const completedTurn =
          params.turn && typeof params.turn === "object"
            ? params.turn as Record<string, unknown>
            : {};
        return completedTurn.id === turnId;
      },
    );
  }

  private createNotificationBarrier(
    label: string,
    timeoutMs: number,
    predicate: NotificationWaiter["predicate"],
  ): NotificationBarrier {
    const generation = this.processGeneration;
    let settled = false;
    let waiter: NotificationWaiter;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Goal setup intentionally awaits the request response before deciding
    // whether a failed barrier needs a server-side rollback. Mark the barrier
    // handled immediately so a simultaneous app-server exit cannot surface as
    // an unhandled rejection while the request promise is still unwinding.
    void promise.catch(() => {});
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
    };
    waiter = {
      generation,
      label,
      predicate,
      resolve: () => {
        cleanup();
        resolvePromise();
      },
      reject: (error) => {
        cleanup();
        rejectPromise(error);
      },
      timer: setTimeout(() => {
        waiter.reject(new Error(`Timed out waiting for Codex ${label}`));
      }, timeoutMs),
    };
    this.notificationWaiters.add(waiter);
    return {
      promise,
      cancel: () => {
        cleanup();
        resolvePromise();
      },
    };
  }

  private resolveNotificationWaiters(
    method: string,
    params: Record<string, unknown>,
  ): void {
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.generation !== this.processGeneration) {
        waiter.reject(new Error("Codex app-server generation changed"));
        continue;
      }
      try {
        if (waiter.predicate(method, params)) waiter.resolve(true);
      } catch (error) {
        waiter.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  private rejectNotificationWaiters(error: Error): void {
    for (const waiter of [...this.notificationWaiters]) {
      waiter.reject(error);
    }
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
    onSuccess?: (value: unknown) => void,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestTimeoutError(method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer, onSuccess });
      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private abortActiveServerRequests(): void {
    for (const request of this.activeServerRequests.values()) {
      request.controller.abort();
    }
    this.activeServerRequests.clear();
  }

  private async askServerQuestion(
    requestId: JsonRpcId,
    generation: number,
    question: CodexQuestion,
    timeoutMs: number | null = null,
  ): Promise<string | null | typeof SERVER_REQUEST_RESOLVED> {
    const active = this.activeServerRequests.get(requestId);
    if (
      !active ||
      active.generation !== generation ||
      active.controller.signal.aborted
    ) {
      return SERVER_REQUEST_RESOLVED;
    }
    if (timeoutMs !== null && timeoutMs <= 0) return null;

    const signal = active.controller.signal;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abortListener: (() => void) | null = null;
    const resolved = new Promise<typeof SERVER_REQUEST_RESOLVED>((resolve) => {
      abortListener = () => resolve(SERVER_REQUEST_RESOLVED);
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) resolve(SERVER_REQUEST_RESOLVED);
    });
    const answer = Promise.resolve().then(() =>
      this.options.onQuestion({
        ...question,
        requestId,
        signal,
      })
    );
    const timeout = timeoutMs === null
      ? null
      : new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });

    try {
      return await Promise.race(
        timeout ? [answer, resolved, timeout] : [answer, resolved],
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
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

  private detachUnresponsiveChild(
    child: ChildProcessWithoutNullStreams,
    error: Error,
  ): void {
    if (this.child !== child) return;
    // Fence every late stdout/exit callback from the hung generation before a
    // replacement is allowed to start.
    this.processGeneration += 1;
    child.stdout.removeAllListeners("data");
    this.child = null;
    this.initialized = false;
    this.threadId = null;
    this.activeTurnId = null;
    this.goalActive = false;
    this.goalPendingAfterTurnId = null;
    this.completedTurnIds.clear();
    this.liveCaptureItems.clear();
    this.recentCaptureLines.length = 0;
    this.abandonInFlightOperations(error, true);
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
    let offset = 0;

    while (offset < chunk.length) {
      if (this.discardedProtocolLine) {
        const newline = chunk.indexOf("\n", offset);
        if (newline === -1) {
          this.discardedProtocolLine.length += chunk.length - offset;
          return;
        }
        this.discardedProtocolLine.length += newline - offset;
        this.discardedProtocolLine = null;
        offset = newline + 1;
        continue;
      }

      const newline = chunk.indexOf("\n", offset);
      if (newline === -1) {
        const additionLength = chunk.length - offset;
        const lineLength = this.stdoutBuffer.length + additionLength;
        if (lineLength > MAX_APP_SERVER_JSON_LINE_CHARS) {
          const bufferedPrefix = this.stdoutBuffer.slice(
            0,
            MAX_PROTOCOL_ID_PREFIX_CHARS,
          );
          const prefixRoom = Math.max(
            0,
            MAX_PROTOCOL_ID_PREFIX_CHARS - bufferedPrefix.length,
          );
          const prefix = `${bufferedPrefix}${
            chunk.slice(offset, offset + prefixRoom)
          }`;
          this.beginDiscardingOversizedProtocolLine(prefix, lineLength);
          this.stdoutBuffer = "";
        } else {
          this.stdoutBuffer += chunk.slice(offset);
        }
        return;
      }

      const fragmentLength = newline - offset;
      const lineLength = this.stdoutBuffer.length + fragmentLength;
      if (lineLength > MAX_APP_SERVER_JSON_LINE_CHARS) {
        const bufferedPrefix = this.stdoutBuffer.slice(
          0,
          MAX_PROTOCOL_ID_PREFIX_CHARS,
        );
        const prefixRoom = Math.max(
          0,
          MAX_PROTOCOL_ID_PREFIX_CHARS - bufferedPrefix.length,
        );
        const prefix = `${bufferedPrefix}${
          chunk.slice(offset, Math.min(newline, offset + prefixRoom))
        }`;
        this.rejectOversizedProtocolLine(prefix, lineLength);
        this.stdoutBuffer = "";
        offset = newline + 1;
        continue;
      }

      const line = `${this.stdoutBuffer}${chunk.slice(offset, newline)}`;
      this.stdoutBuffer = "";
      offset = newline + 1;
      if (!line.trim()) continue;
      try {
        this.handleMessage(JSON.parse(line) as JsonRpcMessage, generation);
      } catch (error) {
        this.options.onError?.(`Invalid Codex app-server JSON: ${line.slice(0, 300)}`, error);
      }
    }
  }

  private beginDiscardingOversizedProtocolLine(
    prefix: string,
    length: number,
  ): void {
    const requestId = this.rejectOversizedProtocolLine(prefix, length);
    this.discardedProtocolLine = { length, requestId };
  }

  private rejectOversizedProtocolLine(
    prefix: string,
    length: number,
  ): JsonRpcId | undefined {
    const error = new Error(
      `Codex app-server JSON line exceeded ${
        MAX_APP_SERVER_JSON_LINE_CHARS
      } characters (${length})`,
    );
    this.options.onError?.("Codex app-server protocol line was too large", error);
    const requestId = jsonRpcIdFromProtocolPrefix(prefix);
    if (requestId !== undefined) {
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(error);
      }
    }
    return requestId;
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
        try {
          pending.onSuccess?.(message.result);
        } catch (error) {
          // The server already accepted the operation. Do not retry the user
          // input and create a duplicate turn because a local observer failed.
          this.options.onError?.("Codex response observer failed", error);
        }
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

    if (method === "serverRequest/resolved") {
      const requestId =
        typeof params.requestId === "string" ||
          typeof params.requestId === "number"
          ? params.requestId
          : undefined;
      const active = requestId === undefined
        ? undefined
        : this.activeServerRequests.get(requestId);
      active?.controller.abort();
      this.recordEvent(
        `server request resolved: ${requestId ?? "unknown"}`,
      );
      this.emit("serverRequestResolved", {
        requestId,
        threadId: notificationThreadId ?? active?.threadId,
        method: active?.method,
      });
    } else if (method === "thread/goal/cleared") {
      this.goalTerminalRevision += 1;
      this.goalBarrierReleaseRevision += 1;
      this.goalActive = false;
      this.goalPendingAfterTurnId = null;
      this.recordEvent("goal cleared");
    } else if (method === "thread/goal/updated") {
      const goal =
        params.goal && typeof params.goal === "object"
          ? params.goal as Record<string, unknown>
          : {};
      if (
        ["complete", "completed", "failed", "cancelled", "canceled"]
          .includes(String(goal.status ?? ""))
      ) {
        this.goalTerminalRevision += 1;
        this.goalBarrierReleaseRevision += 1;
        this.goalActive = false;
        this.goalPendingAfterTurnId = null;
      } else if (
        ["active", "paused", "blocked", "usageLimited", "budgetLimited"]
          .includes(String(goal.status ?? ""))
      ) {
        this.goalActive = true;
        if (
          ["paused", "blocked", "usageLimited", "budgetLimited"]
            .includes(String(goal.status ?? ""))
        ) {
          this.goalBarrierReleaseRevision += 1;
          this.goalPendingAfterTurnId = null;
        }
      }
      this.recordEvent(
        `goal ${typeof goal.status === "string" ? goal.status : "updated"}`,
      );
    } else if (method === "model/rerouted") {
      const fromModel =
        typeof params.fromModel === "string" ? params.fromModel : this.model;
      const toModel =
        typeof params.toModel === "string" ? params.toModel : "";
      if (toModel) {
        // A reroute reports the model that served this turn (for example after
        // a cyber-safety fallback). It does not mutate the thread's requested
        // model; sticky changes arrive separately as thread/settings/updated.
        this.recordEvent(`model rerouted: ${fromModel} -> ${toModel}`);
      }
    } else if (method === "thread/settings/updated") {
      const settings =
        params.threadSettings && typeof params.threadSettings === "object"
          ? params.threadSettings as Record<string, unknown>
          : {};
      if (typeof settings.model === "string") this.model = settings.model;
      if (typeof settings.cwd === "string") this.cwd = settings.cwd;
      if (Object.prototype.hasOwnProperty.call(settings, "effort")) {
        this.effort =
          typeof settings.effort === "string" ? settings.effort : "";
      }
      this.updateSupportedEffortsFromCache();
      this.recordEvent(
        `thread settings updated: model=${this.model || "default"}, effort=${this.effort || "default"}, cwd=${this.cwd}`,
      );
      this.refreshCapabilitiesAfterStateChange(this.model);
    } else if (method === "turn/started") {
      const turn = params.turn as { id?: string } | undefined;
      if (
        turn?.id &&
        this.goalPendingAfterTurnId &&
        turn.id !== this.goalPendingAfterTurnId
      ) {
        this.goalPendingAfterTurnId = null;
      }
      if (turn?.id && this.completedTurnIds.has(turn.id)) {
        this.options.onDebug?.(
          `Ignoring completed start for Codex turn ${turn.id}`,
        );
      } else if (
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
        this.appendRecentCaptureText(
          `── TURN ${this.activeTurnId ?? "unknown"} ──`,
        );
        this.recordEvent(`turn started: ${this.activeTurnId ?? "unknown"}`);
      }
    } else if (method === "turn/completed") {
      const turn = params.turn as {
        id?: string;
        status?: string;
        error?: { message?: string } | null;
      } | undefined;
      if (turn?.id) this.rememberCompletedTurn(turn.id);
      this.recordEvent(
        `turn ${turn?.status ?? "completed"}: ${turn?.id ?? this.activeTurnId ?? "unknown"}`,
      );
      if (turn?.error?.message) {
        this.recordEvent(`error: ${turn.error.message}`);
        this.appendRecentCaptureText(`ERROR\n${turn.error.message}`);
      }
      if (!turn?.id || turn.id === this.activeTurnId) {
        this.activeTurnId = null;
        this.liveCaptureItems.clear();
      } else if (this.activeTurnId) {
        this.options.onDebug?.(
          `Ignoring stale completion for Codex turn ${turn.id}; active turn is ${this.activeTurnId ?? "none"}`,
        );
      } else {
        this.options.onDebug?.(
          `Codex turn ${turn.id} completed before it became active locally`,
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
      if (item) {
        this.appendRecentCaptureText(
          renderThreadItem(item as Record<string, unknown>),
        );
      }
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
    this.resolveNotificationWaiters(method, params);
    this.emit("notification", { method, params });
  }

  private rememberCompletedTurn(turnId: string): void {
    this.completedTurnIds.add(turnId);
    while (this.completedTurnIds.size > MAX_COMPLETED_TURN_IDS) {
      const oldest = this.completedTurnIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.completedTurnIds.delete(oldest);
    }
  }

  private updateSupportedEffortsFromCache(): void {
    this.supportedReasoningEfforts = [
      ...(this.reasoningEffortsByModel.get(this.model) ?? []),
    ];
  }

  private refreshCapabilitiesAfterStateChange(
    expectedModel: string,
  ): void {
    // Model/cwd/effort are already authoritative at notification time. Publish
    // them immediately, then publish once more after the model catalog refresh
    // so clients also receive the final effort capability list.
    this.emit("state", this.stateSnapshot());
    void this.refreshModelCapabilities().then(() => {
      if (this.model !== expectedModel) return;
      this.emit("state", this.stateSnapshot());
    });
  }

  private stateSnapshot(): {
    threadId: string | null;
    model: string;
    effort: string;
    availableEfforts: string[];
    cwd: string;
  } {
    return {
      threadId: this.threadId,
      model: this.model,
      effort: this.effort,
      availableEfforts: this.availableEfforts,
      cwd: this.cwd,
    };
  }

  private appendRecentCaptureText(text: string): void {
    if (!text) return;
    for (const rawLine of text.split("\n")) {
      const prefix = `${CAPTURE_TRUNCATION_NOTICE} `;
      const line = rawLine.length < MAX_CAPTURE_BODY_CHARS
        ? rawLine
        : `${prefix}${
          rawLine.slice(
            -(MAX_CAPTURE_BODY_CHARS - prefix.length - 1),
          )
        }`;
      this.recentCaptureLines.push(line);
    }
    while (this.recentCaptureLines.length > MAX_CAPTURE_HISTORY_LINES) {
      this.recentCaptureLines.shift();
    }
    let totalChars = this.recentCaptureLines.reduce(
      (total, line) => total + line.length + 1,
      0,
    );
    while (
      totalChars > MAX_CAPTURE_BODY_CHARS &&
      this.recentCaptureLines.length > 1
    ) {
      const removed = this.recentCaptureLines.shift();
      totalChars -= (removed?.length ?? 0) + 1;
    }
    if (
      totalChars > MAX_CAPTURE_BODY_CHARS &&
      this.recentCaptureLines.length === 1
    ) {
      const prefix = `${CAPTURE_TRUNCATION_NOTICE} `;
      this.recentCaptureLines[0] = `${prefix}${
        this.recentCaptureLines[0].slice(
          -(MAX_CAPTURE_BODY_CHARS - prefix.length - 1),
        )
      }`;
    }
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
    const activeRequest: ActiveServerRequest = {
      generation,
      method,
      threadId: requestThreadId,
      controller: new AbortController(),
    };
    this.activeServerRequests.set(id, activeRequest);

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
            const rawAnswer = await this.askServerQuestion(
              id,
              generation,
              uiQuestion,
              remainingMs,
            );
            if (rawAnswer === SERVER_REQUEST_RESOLVED) return;
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
          const rawAnswer = await this.askServerQuestion(
            id,
            generation,
            {
              ...requestContext,
              isOther: false,
              operatorOnly: true,
              header: "Codex 권한",
              question: `다음 명령 실행을 허용할까요?\n\n${details}`,
              options,
            },
          );
          if (rawAnswer === SERVER_REQUEST_RESOLVED) return;
          const answer = normalizeChoice(rawAnswer ?? "", options);
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
          const rawAnswer = await this.askServerQuestion(
            id,
            generation,
            {
              ...requestContext,
              isOther: false,
              operatorOnly: true,
              header: "Codex 권한",
              question: `${reason}${root}`,
              options,
            },
          );
          if (rawAnswer === SERVER_REQUEST_RESOLVED) return;
          const answer = normalizeChoice(rawAnswer ?? "", options);
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
          const rawAnswer = await this.askServerQuestion(
            id,
            generation,
            {
              ...requestContext,
              isOther: false,
              operatorOnly: true,
              header: "Codex 권한",
              question: [
                String(params.reason ?? "추가 권한 요청"),
                approvalDetail("위치", params.cwd),
                approvalDetail("환경", params.environmentId),
                approvalDetail("요청 권한", requested),
              ].filter(Boolean).join("\n\n"),
              options,
            },
          );
          if (rawAnswer === SERVER_REQUEST_RESOLVED) return;
          const answer = normalizeChoice(rawAnswer ?? "", options);
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
      if (
        generation !== this.processGeneration ||
        activeRequest.controller.signal.aborted
      ) {
        return;
      }
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
    } finally {
      if (this.activeServerRequests.get(id) === activeRequest) {
        this.activeServerRequests.delete(id);
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
    this.recentEvents.push(
      boundCaptureEntry(
        `[${new Date().toISOString()}] ${event}`,
        MAX_CAPTURE_EVENT_CHARS,
      ),
    );
    while (this.recentEvents.length > MAX_CAPTURE_HISTORY_LINES) {
      this.recentEvents.shift();
    }
    let totalChars = this.recentEvents.reduce(
      (total, entry) => total + entry.length + 1,
      0,
    );
    while (
      totalChars > MAX_CAPTURE_BODY_CHARS &&
      this.recentEvents.length > 1
    ) {
      const removed = this.recentEvents.shift();
      totalChars -= (removed?.length ?? 0) + 1;
    }
    if (
      totalChars > MAX_CAPTURE_BODY_CHARS &&
      this.recentEvents.length === 1
    ) {
      this.recentEvents[0] = boundCaptureEntry(
        this.recentEvents[0],
        MAX_CAPTURE_BODY_CHARS,
      );
    }
  }
}
