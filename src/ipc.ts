/**
 * IPC protocol between wrapper and MCP server via Unix domain socket.
 *
 * The wrapper creates a socket server; the MCP server connects as a client.
 * Messages are exchanged as newline-delimited JSON.
 *
 * Exports:
 *   McpToWrapper, WrapperToMcp, JsonLineSocket, createIpcServer, connectToWrapper.
 */

import {
  createServer,
  createConnection,
  type Socket,
  type Server as NetServer,
} from "node:net";
import { unlinkSync } from "node:fs";
import { EventEmitter } from "node:events";

/** Messages from MCP server → wrapper. */
export type McpToWrapper =
  | { type: "restart"; reason: "new" }
  | { type: "compact"; hint?: string }
  | { type: "clear" }
  | { type: "model"; model: string }
  | { type: "cwd"; cwd: string }
  | { type: "ready" }
  | { type: "capture" };

/** Messages from wrapper → MCP server. */
export type WrapperToMcp =
  | { type: "config"; model: string; cwd: string }
  | { type: "capture_result"; text: string };

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

  send(msg: McpToWrapper | WrapperToMcp): void {
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
 *   onConnection: Called when the MCP server connects.
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
 * Connect to the wrapper's IPC socket (MCP server side).
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
