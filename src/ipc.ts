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
import { unlinkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

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
  | IpcCommandRequest
  | { type: "effort"; request_id: string; effort: string }
  | {
      type: "ready";
      /** Platform identity used to flush only matching routed output. */
      source?: IpcOrigin["source"];
    }
  | { type: "capture"; all?: boolean; request_id?: string }
  | {
      type: "input_response";
      request_id: string;
      answer: string;
      /** Origin of the answer, used to reject cross-channel responses. */
      origin?: IpcOrigin;
    }
  | { type: "input_request_failed"; request_id: string; reason: string }
  // ── from the hook-runner subprocess ──
  | { type: "pre_ask_user_question"; tool_input: AskUserQuestionInput };

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
  | { type: "capture_result"; text: string; request_id?: string }
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
    };

/** Minimal sender surface used by ``IpcCommandTracker`` and test doubles. */
export interface IpcMessageSender {
  send(msg: PeerToWrapper | WrapperToMcp): void;
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
 * Bidirectional JSON-line protocol over a raw socket.
 */
export class JsonLineSocket extends EventEmitter {
  private buffer = "";

  constructor(private socket: Socket) {
    super();
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          this.emit("message", JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
    });
    socket.on("close", () => this.emit("close"));
    socket.on("error", (err) => this.emit("error", err));
  }

  send(msg: PeerToWrapper | WrapperToMcp): void {
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  destroy(): void {
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
export function createIpcServer(
  socketPath: string,
  onConnection: (client: JsonLineSocket) => void,
): NetServer {
  try {
    unlinkSync(socketPath);
  } catch {
    // socket file may not exist
  }

  const server = createServer((socket) => {
    onConnection(new JsonLineSocket(socket));
  });
  server.listen(socketPath);
  return server;
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
export function connectToWrapper(socketPath: string): Promise<JsonLineSocket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath, () => {
      resolve(new JsonLineSocket(socket));
    });
    socket.on("error", reject);
  });
}
