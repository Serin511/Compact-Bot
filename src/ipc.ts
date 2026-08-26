/**
 * IPC protocol between the wrapper and its peers via Unix domain socket.
 *
 * The wrapper creates a socket server. Two kinds of clients connect:
 *   1. MCP servers (Discord / Slack), bidirectional and long-lived.
 *   2. The hook-runner subprocess spawned by Claude Code's PreToolUse hook,
 *      one-shot and write-only — it forwards the AskUserQuestion tool input
 *      and exits immediately so Claude Code can render the Ink widget.
 *
 * All messages are newline-delimited JSON.
 *
 * Exports:
 *   PeerToWrapper, WrapperToMcp, JsonLineSocket, createIpcServer, connectToWrapper.
 */

import {
  createServer,
  createConnection,
  type Socket,
  type Server as NetServer,
} from "node:net";
import { chmodSync, unlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { acquireLoopbackGuard } from "./loopback-guard.js";

/** Private transport field attached to every authenticated IPC JSON object. */
export const IPC_AUTH_FIELD = "__compact_bot_ipc_auth";
/** A capture may be large, but an unbounded unterminated line is never valid. */
export const DEFAULT_MAX_IPC_LINE_BYTES = 8 * 1024 * 1024;

/** Chat platform identifiers used to route command results and agent replies. */
export interface IpcOrigin {
  source: "discord" | "slack";
  chat_id: string;
  message_id: string;
  user?: string;
  ts?: string;
  /** Slack conversation thread. Omitted for Discord and top-level Slack messages. */
  thread_ts?: string;
}

/**
 * Platform tools whose target must remain inside the owning conversation.
 *
 * The historical name is retained because it is part of the internal IPC
 * surface, but reads are guarded too: an allowlisted channel must not be used
 * to fetch another allowlisted conversation's history or attachments.
 */
export type IpcOutboundWriteTool =
  | "reply"
  | "react"
  | "edit_message"
  | "fetch_messages"
  | "download_attachment";

/**
 * One exact Codex MCP conversation-tool invocation awaiting app-server
 * authorization.
 *
 * The wrapper canonicalizes the full arguments with source/server/tool and
 * matches them to an authoritative `item/started` notification.
 */
export interface IpcOutboundAuthorizationRequest {
  type: "authorize_outbound";
  request_id: string;
  source: IpcOrigin["source"];
  server: string;
  tool: IpcOutboundWriteTool;
  arguments: Record<string, unknown>;
}

/** Fail-closed wrapper decision for one outbound MCP tool invocation. */
export interface IpcOutboundAuthorizationResult {
  type: "outbound_authorization_result";
  request_id: string;
  ok: boolean;
  error?: string;
}

/** Whether a routed message belongs to the named platform process. */
export function isOriginForPlatform(
  origin: IpcOrigin | undefined,
  source: IpcOrigin["source"],
): origin is IpcOrigin {
  return origin?.source === source;
}

/**
 * Compare a request origin with a later answer origin.
 *
 * Message IDs intentionally differ between the prompt and its answer. The
 * stable security boundary is platform + channel + Slack thread + user ID.
 */
export function sameConversationOrigin(
  expected: IpcOrigin,
  actual: IpcOrigin,
): boolean {
  if (expected.source !== actual.source) return false;
  if (expected.chat_id !== actual.chat_id) return false;
  if (
    expected.source === "slack" &&
    expected.thread_ts !== actual.thread_ts
  ) {
    return false;
  }
  if (expected.user && expected.user !== actual.user) return false;
  return true;
}

/** Commands whose completion is acknowledged asynchronously by the wrapper. */
export type IpcCommandName =
  | "restart"
  | "compact"
  | "clear"
  | "model"
  | "cwd"
  | "esc"
  | "raw"
  | "goal";

/**
 * Correlation and routing data shared by mutable command requests.
 *
 * All fields are optional so older MCP clients and wrappers remain wire
 * compatible. New clients always populate them. ``success_message`` is echoed
 * by the wrapper in ``command_result.message`` so a replacement MCP child can
 * finish the acknowledgement even when the requesting child was terminated by
 * a session restart.
 */
export interface IpcCommandContext {
  request_id?: string;
  origin?: IpcOrigin;
  success_message?: string;
}

/** A single AskUserQuestion option as relayed over IPC. */
export interface IpcAskOption {
  label: string;
  description: string | null;
}

/** Structured AskUserQuestion payload carried by `input_request` to MCP servers. */
export interface IpcAskWidget {
  header: string | null;
  question: string;
  options: IpcAskOption[];
  /** Whether a free-form answer is allowed. Undefined preserves legacy true. */
  allowOther?: boolean;
  /** Secret input must never be rendered or collected in a public chat. */
  isSecret?: boolean;
  /** 1-based question index within the call. 1 when there's only one question. */
  questionIndex: number;
  /** Total number of questions in this AskUserQuestion call (1..4). */
  questionTotal: number;
}

/**
 * Validate a plain-text answer against a question's free-form policy.
 *
 * When free-form input is disabled, only a valid 1-based option number or an
 * exact option label is accepted. Undefined ``allowOther`` preserves the
 * legacy behaviour where arbitrary text was allowed.
 */
export function isAllowedInputAnswer(
  widget: IpcAskWidget | undefined,
  answer: string,
): boolean {
  if (!widget || widget.allowOther !== false) return true;
  const trimmed = answer.trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed);
    return index >= 1 && index <= widget.options.length;
  }
  return widget.options.some((option) => option.label === trimmed);
}

/** Exact correlation guard for an input-request cancellation notification. */
export function isMatchingInputRequest(
  pendingRequestId: string | undefined,
  cancelledRequestId: string,
): boolean {
  return pendingRequestId === cancelledRequestId;
}

/**
 * Single question structure as Claude Code passes it to the PreToolUse hook.
 *
 * Mirrors the AskUserQuestion tool's input schema (see Claude Code 2.1.132+):
 * 1-4 questions per call, each with 2-4 options, optional preview / multi-select.
 * The wrapper only consumes a subset of these fields — preview rendering and
 * multi-select are downgraded to plain-text on the channel side.
 */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{
    label: string;
    description?: string;
    preview?: string;
  }>;
}

/** Tool input shape Claude Code passes to the PreToolUse hook for AskUserQuestion. */
export interface AskUserQuestionInput {
  questions: AskQuestion[];
}

/** Mutable command requests received by the wrapper. */
export type IpcCommandRequest =
  | ({ type: "restart"; reason: "new" } & IpcCommandContext)
  | ({ type: "compact"; hint?: string } & IpcCommandContext)
  | ({ type: "clear" } & IpcCommandContext)
  | ({ type: "model"; model: string } & IpcCommandContext)
  | ({ type: "cwd"; cwd: string } & IpcCommandContext)
  | ({ type: "esc" } & IpcCommandContext)
  | ({ type: "raw"; text: string } & IpcCommandContext)
  | ({ type: "goal"; args: string } & IpcCommandContext);

/** Messages received by the wrapper. */
export type PeerToWrapper =
  // ── from MCP servers ──
  | {
      type: "user_message";
      source: "discord" | "slack";
      content: string;
      meta: Record<string, string>;
    }
  | {
      type: "channel_activity";
      /** Most recent Claude-channel message target for hook-driven prompts. */
      origin: IpcOrigin;
    }
  | IpcCommandRequest
  | {
      type: "effort";
      request_id: string;
      effort: string;
      /** Exact command conversation, retained across MCP process replacement. */
      origin?: IpcOrigin;
    }
  | {
      type: "ready";
      /** Platform identity used to flush only matching routed output. */
      source?: IpcOrigin["source"];
    }
  | {
      type: "not_ready";
      /** Platform connection that can no longer receive realtime events. */
      source: IpcOrigin["source"];
    }
  | {
      type: "capture";
      all?: boolean;
      request_id?: string;
      /** Exact command conversation, retained across MCP process replacement. */
      origin?: IpcOrigin;
    }
  | {
      type: "input_response";
      request_id: string;
      answer: string;
      /** Origin of the answer, used to reject cross-channel responses. */
      origin?: IpcOrigin;
    }
  | { type: "input_request_failed"; request_id: string; reason: string }
  | IpcOutboundAuthorizationRequest
  // ── from the hook-runner subprocess ──
  | {
      type: "pre_ask_user_question";
      tool_input: AskUserQuestionInput;
      /** Exact causal channel recovered from Claude's hook transcript. */
      origin?: IpcOrigin;
    };

/**
 * Backwards-compat alias — older code in mcp-server / slack-mcp-server still
 * imports this name. New code should prefer ``PeerToWrapper``.
 */
export type McpToWrapper = PeerToWrapper;

/** Completion of a mutable IPC command. */
export interface IpcCommandResult {
  type: "command_result";
  request_id: string;
  command: IpcCommandName;
  ok: boolean;
  /** Exact platform destination; required for replacement-child delivery. */
  origin?: IpcOrigin;
  /** User-facing success or failure text selected by the wrapper. */
  message?: string;
  error?: string;
}

/** Messages from wrapper → MCP server. */
export type WrapperToMcp =
  | {
      type: "config";
      provider: "claude" | "codex";
      model: string;
      effort: string;
      availableEfforts: string[];
      cwd: string;
    }
  | {
      type: "capture_result";
      text: string;
      request_id?: string;
      /** Exact platform destination; required for replacement-child delivery. */
      origin?: IpcOrigin;
      /** Preserve the caller's rendering choice after process replacement. */
      all?: boolean;
    }
  | IpcCommandResult
  | {
      type: "agent_reply";
      origin: IpcOrigin;
      text: string;
    }
  | {
      type: "effort_result";
      request_id: string;
      ok: boolean;
      effort: string;
      availableEfforts: string[];
      error?: string;
      /** Exact platform destination; required for replacement-child delivery. */
      origin?: IpcOrigin;
    }
  | {
      type: "input_request";
      request_id: string;
      /** Plain-text rendering of the widget — used as a log preview. */
      question: string;
      /** Structured widget data (always present for AskUserQuestion). */
      widget?: IpcAskWidget;
      /**
       * Turn-scoped target. Older wrappers may omit it, in which case clients
       * retain their last-active-channel fallback.
       */
      origin?: IpcOrigin;
    }
  | {
      type: "input_request_cancel";
      request_id: string;
    }
  | IpcOutboundAuthorizationResult;

/** Minimal sender surface used by ``IpcCommandTracker`` and test doubles. */
export interface IpcMessageSender {
  send(msg: PeerToWrapper | WrapperToMcp): void;
}

/**
 * Register a platform process with the wrapper only after it owns a usable
 * realtime connection.
 *
 * Codex app-server can spawn more than one copy of a configured MCP server.
 * Non-owner copies still need to serve MCP over stdio, but must not become
 * wrapper routing targets because they cannot receive Discord/Slack button
 * events.
 */
export function announceRealtimeReady(
  sender: IpcMessageSender | null,
  source: IpcOrigin["source"],
  realtimeReady: boolean,
): boolean {
  if (!sender || !realtimeReady) return false;
  sender.send({ type: "ready", source });
  return true;
}

/**
 * Remove a platform process from wrapper routing as soon as its realtime
 * connection drops. The same process may announce ``ready`` again after the
 * SDK reconnects.
 */
export function announceRealtimeNotReady(
  sender: IpcMessageSender | null,
  source: IpcOrigin["source"],
): boolean {
  if (!sender) return false;
  sender.send({ type: "not_ready", source });
  return true;
}

/**
 * Tracks mutable command requests without installing one EventEmitter listener
 * per request. The MCP client's central IPC handler feeds every
 * ``command_result`` to ``settle``; unknown results can then be delivered
 * directly using their embedded origin (the requesting child may have died).
 */
export class IpcCommandTracker {
  private pending = new Map<
    string,
    {
      resolve: (result: IpcCommandResult) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private known = new Set<string>();

  request(
    sender: IpcMessageSender | null,
    request: IpcCommandRequest,
    // A Codex runtime replacement can spend up to a minute in an individual
    // app-server request after cleaning up the previous process generation.
    // Keep the client correlation alive long enough to receive the real
    // success/failure instead of reporting a false timeout mid-restart.
    timeoutMs = 180_000,
  ): Promise<IpcCommandResult> {
    const requestId = request.request_id ?? randomUUID();
    const outbound = { ...request, request_id: requestId } satisfies IpcCommandRequest;

    if (!sender) {
      return Promise.resolve({
        type: "command_result",
        request_id: requestId,
        command: request.type,
        ok: false,
        origin: request.origin,
        error: "wrapper 연결 없음",
      });
    }

    this.known.add(requestId);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          type: "command_result",
          request_id: requestId,
          command: request.type,
          ok: false,
          origin: request.origin,
          error: "wrapper 응답 시간 초과",
        });
        this.expireKnown(requestId);
      }, timeoutMs);

      this.pending.set(requestId, { resolve, timeout });
      sender.send(outbound);
    });
  }

  /**
   * Resolve a locally pending request.
   *
   * Returns true for locally known results (including late duplicates), so the
   * caller can suppress direct posting. Returns false in a replacement child,
   * where the result must be delivered from its embedded origin.
   */
  settle(result: IpcCommandResult): boolean {
    const pending = this.pending.get(result.request_id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(result.request_id);
      pending.resolve(result);
      this.expireKnown(result.request_id);
      return true;
    }
    return this.known.has(result.request_id);
  }

  private expireKnown(requestId: string): void {
    setTimeout(() => this.known.delete(requestId), 60_000).unref();
  }
}

/**
 * Correlate a routed query-style result such as `/capture` or `/effort`.
 *
 * The requesting platform process resolves a locally known result. A fresh
 * replacement process has no matching request ID, so `settle` returns false
 * and its central IPC handler can deliver the result using the embedded
 * origin. Recently settled IDs remain known briefly to suppress duplicates.
 */
export class IpcRoutedResultTracker<
  TResult extends { request_id?: string },
> {
  private pending = new Map<
    string,
    {
      resolve: (result: TResult | null) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private known = new Set<string>();

  request(
    sender: IpcMessageSender | null,
    request: PeerToWrapper & { request_id: string },
    timeoutMs = 180_000,
  ): Promise<TResult | null> {
    if (!sender) return Promise.resolve(null);

    const requestId = request.request_id;
    this.known.add(requestId);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
        this.expireKnown(requestId);
      }, timeoutMs);
      timeout.unref();

      this.pending.set(requestId, { resolve, timeout });
      try {
        sender.send(request);
      } catch {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        resolve(null);
        this.expireKnown(requestId);
      }
    });
  }

  /**
   * Resolve a locally pending request.
   *
   * A missing request ID is accepted only when exactly one request is pending,
   * preserving compatibility with older wrappers without allowing an
   * ambiguous response to settle the wrong command.
   */
  settle(result: TResult): boolean {
    const requestId = result.request_id ?? (
      this.pending.size === 1
        ? this.pending.keys().next().value as string | undefined
        : undefined
    );
    if (!requestId) return false;

    const pending = this.pending.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.resolve(result);
      this.expireKnown(requestId);
      return true;
    }
    return this.known.has(requestId);
  }

  private expireKnown(requestId: string): void {
    setTimeout(() => this.known.delete(requestId), 60_000).unref();
  }
}

/**
 * Correlate one fail-closed Codex outbound-tool authorization request.
 *
 * Unlike realtime routing, the wrapper replies to the requesting socket
 * directly, so this works for MCP tool processes that never announced
 * `ready`. A missing socket, disconnect, or timeout always denies the tool.
 */
export class IpcOutboundAuthorizationTracker {
  private pending = new Map<
    string,
    {
      resolve: (result: IpcOutboundAuthorizationResult) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  request(
    sender: IpcMessageSender | null,
    request: Omit<IpcOutboundAuthorizationRequest, "type" | "request_id">,
    // The wrapper's guard may itself wait up to 5s for item/started or turn
    // classification. Keep this outer correlation deadline strictly longer.
    timeoutMs = 7_000,
  ): Promise<IpcOutboundAuthorizationResult> {
    const requestId = randomUUID();
    if (!sender) {
      return Promise.resolve({
        type: "outbound_authorization_result",
        request_id: requestId,
        ok: false,
        error: "wrapper 연결 없음",
      });
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({
          type: "outbound_authorization_result",
          request_id: requestId,
          ok: false,
          error: "outbound authorization timeout",
        });
      }, timeoutMs);
      timeout.unref();
      this.pending.set(requestId, { resolve, timeout });
      try {
        sender.send({
          type: "authorize_outbound",
          request_id: requestId,
          ...request,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        resolve({
          type: "outbound_authorization_result",
          request_id: requestId,
          ok: false,
          error:
            error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  settle(result: IpcOutboundAuthorizationResult): boolean {
    const pending = this.pending.get(result.request_id);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(result.request_id);
    pending.resolve(result);
    return true;
  }

  denyAll(error = "wrapper 연결 종료"): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.resolve({
        type: "outbound_authorization_result",
        request_id: requestId,
        ok: false,
        error,
      });
    }
    this.pending.clear();
  }
}

/**
 * Bidirectional JSON-line protocol over a raw socket.
 */
export class JsonLineSocket extends EventEmitter {
  private buffer = Buffer.alloc(0);
  private readonly expectedAuthToken?: string;
  private readonly outboundAuthToken?: string;
  private readonly maxLineBytes: number;

  constructor(
    private socket: Socket,
    options: {
      expectedAuthToken?: string;
      outboundAuthToken?: string;
      maxLineBytes?: number;
    } = {},
  ) {
    super();
    this.expectedAuthToken = options.expectedAuthToken || undefined;
    this.outboundAuthToken = options.outboundAuthToken || undefined;
    this.maxLineBytes =
      options.maxLineBytes ?? DEFAULT_MAX_IPC_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }

    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      let idx: number;
      while ((idx = this.buffer.indexOf(0x0a)) !== -1) {
        const line = this.buffer.subarray(0, idx);
        this.buffer = this.buffer.subarray(idx + 1);
        if (line.length > this.maxLineBytes) {
          this.rejectProtocol("IPC message exceeded the maximum line size");
          return;
        }
        const text = line.toString("utf8");
        if (!text.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(text);
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
          ) {
            this.rejectProtocol("IPC message must be a JSON object");
            return;
          }
          const record = parsed as Record<string, unknown>;
          if (
            this.expectedAuthToken &&
            record[IPC_AUTH_FIELD] !== this.expectedAuthToken
          ) {
            this.rejectProtocol("IPC authentication failed");
            return;
          }
          // Authentication is a transport concern and must never reach the
          // wrapper/MCP application handlers or their debug output.
          delete record[IPC_AUTH_FIELD];
          this.emit("message", record);
        } catch {
          // skip malformed lines
        }
      }
      if (this.buffer.length > this.maxLineBytes) {
        this.rejectProtocol("IPC message exceeded the maximum line size");
      }
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
  }

  send(msg: PeerToWrapper | WrapperToMcp): void {
    if (this.socket.destroyed || !this.socket.writable) {
      throw new Error("IPC socket is not writable");
    }
    const payload = {
      ...msg,
      ...(this.outboundAuthToken
        ? { [IPC_AUTH_FIELD]: this.outboundAuthToken }
        : {}),
    };
    const line = JSON.stringify(payload) + "\n";
    if (Buffer.byteLength(line) - 1 > this.maxLineBytes) {
      throw new RangeError("IPC message exceeded the maximum line size");
    }
    this.socket.write(line);
  }

  destroy(): void {
    this.socket.destroy();
  }

  private rejectProtocol(reason: string): void {
    this.emit("protocolError", new Error(reason));
    this.socket.destroy();
  }
}

/**
 * Create an IPC socket server (wrapper side).
 *
 * Args:
 *   socketPath: Unix domain socket path.
 *   onConnection: Called for each connecting peer.
 *
 * Returns:
 *   The net.Server instance.
 */
const IPC_PROBE_TIMEOUT_MS = 500;

function probeIpcServer(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(IPC_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Serialize wrapper startup with an OS-owned listener that vanishes on crash.
 */
function acquireIpcStartupGuard(
  socketPath: string,
): Promise<NetServer | null> {
  return acquireLoopbackGuard(`wrapper-startup\0${socketPath}`, {
    portBase: 32_768,
  });
}

function listenIpcServer(
  server: NetServer,
  socketPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export async function createIpcServer(
  socketPath: string,
  onConnection: (client: JsonLineSocket) => void,
  options: {
    authToken?: string;
    maxLineBytes?: number;
  } = {},
): Promise<NetServer> {
  const startupGuard = await acquireIpcStartupGuard(socketPath);
  if (!startupGuard) {
    throw new Error(
      `Another Compact Bot wrapper is already starting for ${socketPath}`,
    );
  }
  const server = createServer((socket) => {
    onConnection(new JsonLineSocket(socket, {
      expectedAuthToken: options.authToken,
      outboundAuthToken: options.authToken,
      maxLineBytes: options.maxLineBytes,
    }));
  });

  if (await probeIpcServer(socketPath)) {
    startupGuard.close();
    throw new Error(
      `Another Compact Bot wrapper is already listening on ${socketPath}`,
    );
  }
  // A failed probe means either no file or a stale socket. Removing that stale
  // path is safe while the startup guard excludes other new wrappers.
  try {
    unlinkSync(socketPath);
  } catch (unlinkError) {
    if (
      !(
        unlinkError &&
        typeof unlinkError === "object" &&
        "code" in unlinkError &&
        unlinkError.code === "ENOENT"
      )
    ) {
      startupGuard.close();
      throw unlinkError;
    }
  }

  try {
    await listenIpcServer(server, socketPath);
    // The parent directory is private as well, but enforce the socket mode
    // explicitly so a permissive process umask cannot expose wrapper control.
    chmodSync(socketPath, 0o600);
    return server;
  } catch (error) {
    try {
      server.close();
    } catch {
      // The listen attempt may have failed before the server started.
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore cleanup failure; the original startup error is more useful
    }
    throw error;
  } finally {
    startupGuard.close();
  }
}

/**
 * Connect to the wrapper's IPC socket (peer side — MCP server or hook-runner).
 *
 * Args:
 *   socketPath: Unix domain socket path.
 *
 * Returns:
 *   Promise resolving to a JsonLineSocket.
 */
export function connectToWrapper(
  socketPath: string,
  authToken = process.env.COMPACT_BOT_IPC_AUTH_TOKEN || undefined,
): Promise<JsonLineSocket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      resolve(new JsonLineSocket(socket, {
        expectedAuthToken: authToken,
        outboundAuthToken: authToken,
      }));
    });
    socket.on("error", reject);
  });
}
