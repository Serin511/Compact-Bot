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
  /** 1-based question index within the call. 1 when there's only one question. */
  questionIndex: number;
  /** Total number of questions in this AskUserQuestion call (1..4). */
  questionTotal: number;
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

/** Messages received by the wrapper. */
export type PeerToWrapper =
  // ── from MCP servers ──
  | { type: "restart"; reason: "new" }
  | { type: "compact"; hint?: string }
  | { type: "clear" }
  | { type: "model"; model: string }
  | { type: "cwd"; cwd: string }
  | { type: "ready" }
  | { type: "capture"; all?: boolean }
  | { type: "input_response"; request_id: string; answer: string }
  | { type: "input_request_failed"; request_id: string; reason: string }
  | { type: "esc" }
  | { type: "raw"; text: string }
  // ── from the hook-runner subprocess ──
  | { type: "pre_ask_user_question"; tool_input: AskUserQuestionInput };

/**
 * Backwards-compat alias — older code in mcp-server / slack-mcp-server still
 * imports this name. New code should prefer ``PeerToWrapper``.
 */
export type McpToWrapper = PeerToWrapper;

/** Messages from wrapper → MCP server. */
export type WrapperToMcp =
  | { type: "config"; model: string; cwd: string }
  | { type: "capture_result"; text: string }
  | {
      type: "input_request";
      request_id: string;
      /** Plain-text rendering of the widget — used as a log preview. */
      question: string;
      /** Structured widget data (always present for AskUserQuestion). */
      widget?: IpcAskWidget;
    };

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
