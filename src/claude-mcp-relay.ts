/**
 * Wrapper-owned platform MCP relay for Claude Code and Codex.
 *
 * Both hosts receive only a secretless byte-stream proxy definition. The
 * wrapper owns the real Discord/Slack MCP process, injects its sensitive
 * runtime values over a private inherited file descriptor, and bridges only
 * MCP stdio bytes to the proxy. Neither the proxy nor its config can reach
 * wrapper IPC credentials.
 */

import {
  chmodSync,
  unlinkSync,
} from "node:fs";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  spawn,
  type ChildProcess,
} from "node:child_process";
import type {
  Readable,
  Writable,
} from "node:stream";
import { MCP_RUNTIME_FD_ENV } from "./mcp-runtime-environment.js";

export type ClaudeMcpPlatform = "discord" | "slack";

export interface ClaudeMcpServerSpec {
  name: string;
  json: string;
}

export interface CodexMcpProxyConfig {
  name: string;
  command: string;
  args: string[];
  envVars: string[];
}

export interface ClaudeMcpRelayOptions {
  nodeExecutable: string;
  entrypoints: Record<ClaudeMcpPlatform, string>;
  baseEnvironment?: NodeJS.ProcessEnv;
  shutdownGraceMs?: number;
  initializeTimeoutMs?: number;
  onDebug?: (message: string) => void;
  onError?: (message: string, error: unknown) => void;
}

interface RelayHandshake {
  version: 1;
  platform: ClaudeMcpPlatform;
}

interface RelaySession {
  platform: ClaudeMcpPlatform;
  generation: number;
  socket: Socket;
  child: ChildProcess;
  childInput: Writable;
  childOutput: Readable;
  forceKillTimer: NodeJS.Timeout | null;
  initializeTimer: NodeJS.Timeout | null;
  initialInput: Buffer;
  initialized: boolean;
  stderrBuffer: string;
  closing: boolean;
}

const MAX_HANDSHAKE_BYTES = 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const INITIALIZE_TIMEOUT_MS = 5_000;
const MAX_INITIALIZE_BYTES = 1024 * 1024;
const MAX_STDERR_BUFFER_BYTES = 64 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const MCP_RUNTIME_FD = 3;

const PLATFORM_SECRET_ENV_KEYS = new Set([
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "COMPACT_BOT_IPC_AUTH_TOKEN",
  "COMPACT_BOT_HOOK_IPC_AUTH_TOKEN",
  "COMPACT_BOT_WRAPPER_SOCKET",
  "WRAPPER_SOCKET",
]);

function isPlatform(value: unknown): value is ClaudeMcpPlatform {
  return value === "discord" || value === "slack";
}

function parseHandshake(line: Buffer): RelayHandshake | null {
  if (line.length > MAX_HANDSHAKE_BYTES) return null;
  try {
    const value: unknown = JSON.parse(line.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !isPlatform(record.platform)) return null;
    return { version: 1, platform: record.platform };
  } catch {
    return null;
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
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

function probeRelay(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);
    timer.unref();
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function secretlessChildEnvironment(
  base: NodeJS.ProcessEnv,
  payload: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      !PLATFORM_SECRET_ENV_KEYS.has(key) &&
      !(key in payload)
    ) {
      environment[key] = value;
    }
  }
  environment[MCP_RUNTIME_FD_ENV] = String(MCP_RUNTIME_FD);
  return environment;
}

function redactRuntimeValues(
  text: string,
  payload: Readonly<Record<string, string>>,
): string {
  let redacted = text;
  for (const value of Object.values(payload)) {
    if (value.length >= 4) redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

/** Build the exact secretless JSON persisted by `claude mcp add-json`. */
export function buildClaudeMcpServerSpec(
  platform: ClaudeMcpPlatform,
  nodeExecutable: string,
  proxyPath: string,
  relaySocketPath: string,
): ClaudeMcpServerSpec {
  return {
    name: platform === "discord" ? "discord-bot" : "slack-bot",
    json: JSON.stringify({
      command: nodeExecutable,
      args: [proxyPath, platform, relaySocketPath],
    }),
  };
}

/** Build one secretless process-local Codex MCP proxy definition. */
export function buildCodexMcpProxyConfig(
  platform: ClaudeMcpPlatform,
  nodeExecutable: string,
  proxyPath: string,
  relaySocketPath: string,
): CodexMcpProxyConfig {
  return {
    name:
      platform === "discord"
        ? "compact_bot_discord"
        : "compact_bot_slack",
    command: nodeExecutable,
    args: [proxyPath, platform, relaySocketPath],
    envVars: [],
  };
}

/**
 * A Unix socket that exposes one MCP byte stream per configured platform.
 *
 * Runtime payloads never cross this socket. They travel from the wrapper to
 * its own child over fd 3. A peer that discovers the relay can therefore reach
 * only the same MCP JSON-RPC surface Claude is intentionally given.
 */
export class ClaudeMcpRelayServer {
  private readonly sessions = new Map<ClaudeMcpPlatform, RelaySession>();
  private readonly connections = new Set<Socket>();
  private readonly children = new Set<ChildProcess>();
  private payloads = new Map<
    ClaudeMcpPlatform,
    Readonly<Record<string, string>>
  >();
  private generation = 0;
  private closed = false;
  private lifecycle: Promise<void> = Promise.resolve();

  private constructor(
    readonly socketPath: string,
    private readonly server: Server,
    private readonly options: ClaudeMcpRelayOptions,
  ) {}

  static async create(
    socketPath: string,
    options: ClaudeMcpRelayOptions,
  ): Promise<ClaudeMcpRelayServer> {
    if (await probeRelay(socketPath)) {
      throw new Error(
        `Another Compact Bot MCP relay is already listening on ${socketPath}`,
      );
    }
    try {
      unlinkSync(socketPath);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    let relay!: ClaudeMcpRelayServer;
    const server = createServer((socket) => relay.handleConnection(socket));
    relay = new ClaudeMcpRelayServer(socketPath, server, options);
    await listen(server, socketPath);
    chmodSync(socketPath, 0o600);
    return relay;
  }

  /**
   * Replace the current Claude generation.
   *
   * Existing proxies and MCP children are terminated together. The payloads
   * remain wrapper-private and support a later proxy/MCP restart without ever
   * being written into Claude-owned state.
   */
  startGeneration(
    payloads: Readonly<
      Partial<Record<ClaudeMcpPlatform, Readonly<Record<string, string>>>>
    >,
  ): Promise<void> {
    const copy: Partial<
      Record<ClaudeMcpPlatform, Readonly<Record<string, string>>>
    > = {};
    for (const platform of ["discord", "slack"] as const) {
      if (payloads[platform]) copy[platform] = { ...payloads[platform] };
    }
    return this.enqueueLifecycle(async () => {
      if (this.closed) throw new Error("Claude MCP relay is closed");
      await this.stopGenerationNow();
      if (this.closed) throw new Error("Claude MCP relay is closed");
      for (const platform of ["discord", "slack"] as const) {
        const payload = copy[platform];
        if (payload) {
          this.payloads.set(platform, Object.freeze({ ...payload }));
        }
      }
    });
  }

  /** Revoke the active generation and stop every platform child. */
  stopGeneration(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopGenerationNow());
  }

  private async stopGenerationNow(): Promise<void> {
    this.generation += 1;
    this.payloads.clear();
    const children = [...this.children];
    for (const socket of [...this.connections]) socket.destroy();
    for (const session of [...this.sessions.values()]) {
      this.stopSession(session, "generation stopped");
    }
    await this.waitForChildren(children);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stopGeneration();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
    try {
      unlinkSync(this.socketPath);
    } catch {
      // The server or another cleanup path may already have removed it.
    }
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation, operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  private handleConnection(socket: Socket): void {
    this.connections.add(socket);
    const connectionGeneration = this.generation;
    let buffer = Buffer.alloc(0);
    let complete = false;
    const timeout = setTimeout(() => {
      socket.destroy(new Error("Claude MCP relay handshake timed out"));
    }, HANDSHAKE_TIMEOUT_MS);
    timeout.unref();

    const cleanupHandshake = (): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
    };
    const onData = (chunk: Buffer): void => {
      if (complete) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (
        (newline === -1 && buffer.length > MAX_HANDSHAKE_BYTES) ||
        newline > MAX_HANDSHAKE_BYTES
      ) {
        cleanupHandshake();
        socket.destroy(new Error("invalid Claude MCP relay handshake"));
        return;
      }
      if (newline === -1) return;
      complete = true;
      cleanupHandshake();
      const handshake = parseHandshake(buffer.subarray(0, newline));
      const initialMcpBytes = buffer.subarray(newline + 1);
      buffer = Buffer.alloc(0);
      if (
        !handshake ||
        connectionGeneration !== this.generation ||
        !this.payloads.has(handshake.platform)
      ) {
        socket.destroy(new Error("Claude MCP relay is unavailable"));
        return;
      }
      this.startOrQueueSession(
        handshake.platform,
        connectionGeneration,
        socket,
        initialMcpBytes,
      );
    };

    socket.on("data", onData);
    socket.once("close", () => {
      cleanupHandshake();
      this.connections.delete(socket);
      const session = [...this.sessions.values()].find(
        (candidate) => candidate.socket === socket,
      );
      if (session) this.stopSession(session, "proxy disconnected");
    });
    socket.on("error", () => {
      // Connection failures are contained to this proxy/session.
    });
  }

  private startOrQueueSession(
    platform: ClaudeMcpPlatform,
    generation: number,
    socket: Socket,
    initialMcpBytes: Buffer,
  ): void {
    const existing = this.sessions.get(platform);
    if (!existing) {
      this.startSession(platform, generation, socket, initialMcpBytes);
      return;
    }
    if (!existing.closing) {
      socket.destroy(new Error("Claude MCP relay is unavailable"));
      return;
    }
    existing.child.once("close", () => {
      if (
        socket.destroyed ||
        generation !== this.generation ||
        !this.payloads.has(platform) ||
        this.sessions.has(platform)
      ) {
        socket.destroy();
        return;
      }
      this.startSession(platform, generation, socket, initialMcpBytes);
    });
  }

  private startSession(
    platform: ClaudeMcpPlatform,
    generation: number,
    socket: Socket,
    initialMcpBytes: Buffer,
  ): void {
    const payload = this.payloads.get(platform);
    if (!payload || generation !== this.generation) {
      socket.destroy();
      return;
    }

    const environment = secretlessChildEnvironment(
      this.options.baseEnvironment ?? process.env,
      payload,
    );
    const child = spawn(
      this.options.nodeExecutable,
      [this.options.entrypoints[platform]],
      {
        env: environment,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
    const childInput = child.stdin;
    const childOutput = child.stdout;
    const childError = child.stderr;
    const runtimePipe = child.stdio[MCP_RUNTIME_FD] as Writable | null;
    if (!childInput || !childOutput || !childError || !runtimePipe) {
      child.kill("SIGKILL");
      socket.destroy(new Error("platform MCP child pipes are unavailable"));
      return;
    }

    const session: RelaySession = {
      platform,
      generation,
      socket,
      child,
      childInput,
      childOutput,
      forceKillTimer: null,
      initializeTimer: null,
      initialInput: Buffer.alloc(0),
      initialized: false,
      stderrBuffer: "",
      closing: false,
    };
    this.sessions.set(platform, session);
    this.children.add(child);

    runtimePipe.on("error", (error) => {
      this.options.onError?.(
        `${platform} MCP runtime channel failed`,
        error,
      );
      this.stopSession(session, "runtime channel failed");
    });
    runtimePipe.end(`${JSON.stringify(payload)}\n`);

    const forwardInput = (chunk: Buffer): void => {
      if (!childInput.write(chunk)) socket.pause();
    };
    const handleMcpInput = (chunk: Buffer): void => {
      if (session.initialized) {
        forwardInput(chunk);
        return;
      }
      session.initialInput = Buffer.concat([session.initialInput, chunk]);
      if (session.initialInput.length > MAX_INITIALIZE_BYTES) {
        this.stopSession(session, "MCP initialize exceeded size limit");
        return;
      }
      const newline = session.initialInput.indexOf(0x0a);
      if (newline === -1) return;
      try {
        const value: unknown = JSON.parse(
          session.initialInput.subarray(0, newline).toString("utf8"),
        );
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          (value as Record<string, unknown>).method !== "initialize"
        ) {
          throw new Error("first MCP request must initialize");
        }
      } catch {
        this.stopSession(session, "invalid MCP initialize request");
        return;
      }
      session.initialized = true;
      if (session.initializeTimer) clearTimeout(session.initializeTimer);
      session.initializeTimer = null;
      const buffered = session.initialInput;
      session.initialInput = Buffer.alloc(0);
      forwardInput(buffered);
    };
    socket.on("data", handleMcpInput);
    childInput.on("drain", () => socket.resume());
    childInput.on("error", () => {
      this.stopSession(session, "MCP stdin failed");
    });

    childOutput.on("data", (chunk: Buffer) => {
      if (!socket.write(chunk)) childOutput.pause();
    });
    socket.on("drain", () => childOutput.resume());
    childOutput.on("error", () => {
      this.stopSession(session, "MCP stdout failed");
    });

    const flushStderrLines = (flushRemainder = false): void => {
      let newline: number;
      while ((newline = session.stderrBuffer.indexOf("\n")) !== -1) {
        const line = session.stderrBuffer.slice(0, newline);
        session.stderrBuffer = session.stderrBuffer.slice(newline + 1);
        const output = redactRuntimeValues(line, payload);
        if (output.trim()) {
          this.options.onDebug?.(`${platform} MCP: ${output}`);
        }
      }
      if (flushRemainder && session.stderrBuffer) {
        const output = redactRuntimeValues(session.stderrBuffer, payload);
        if (output.trim()) {
          this.options.onDebug?.(`${platform} MCP: ${output}`);
        }
        session.stderrBuffer = "";
      }
    };
    childError.on("data", (chunk: Buffer) => {
      session.stderrBuffer += chunk.toString("utf8");
      if (
        Buffer.byteLength(session.stderrBuffer) >
        MAX_STDERR_BUFFER_BYTES
      ) {
        session.stderrBuffer = "";
        this.options.onDebug?.(
          `${platform} MCP: [oversized stderr line suppressed]`,
        );
        return;
      }
      flushStderrLines();
    });
    childError.on("error", () => {
      // stderr diagnostics are best-effort and never part of MCP transport.
    });

    child.once("error", (error) => {
      this.options.onError?.(`${platform} MCP child failed`, error);
      this.stopSession(session, "child process error");
    });
    child.once("close", (code, signal) => {
      flushStderrLines(true);
      this.children.delete(child);
      if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
      session.forceKillTimer = null;
      if (this.sessions.get(platform) === session) {
        this.sessions.delete(platform);
      }
      socket.destroy();
      if (!session.closing) {
        this.options.onError?.(
          `${platform} MCP child exited unexpectedly`,
          new Error(`exit=${String(code)} signal=${String(signal)}`),
        );
      }
    });

    session.initializeTimer = setTimeout(() => {
      this.stopSession(session, "MCP initialize timed out");
    }, this.options.initializeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
    session.initializeTimer.unref();
    // ACK is consumed by the secretless proxy before it begins forwarding
    // Claude's stdin, so MCP bytes can never coalesce with the handshake.
    socket.write('{"ok":true}\n');
    if (initialMcpBytes.length > 0) handleMcpInput(initialMcpBytes);
  }

  private stopSession(session: RelaySession, reason: string): void {
    if (session.closing) return;
    session.closing = true;
    if (session.initializeTimer) clearTimeout(session.initializeTimer);
    session.initializeTimer = null;
    session.socket.destroy();
    try {
      session.childInput.end();
    } catch {
      // The child may already have closed stdin.
    }
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.kill("SIGTERM");
      const grace =
        this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
      session.forceKillTimer = setTimeout(() => {
        if (
          session.child.exitCode === null &&
          session.child.signalCode === null
        ) {
          session.child.kill("SIGKILL");
        }
      }, grace);
      session.forceKillTimer.unref();
    }
    this.options.onDebug?.(`${session.platform} MCP stopped: ${reason}`);
  }

  private async waitForChildren(children: ChildProcess[]): Promise<void> {
    if (children.length === 0) return;
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (
              child.exitCode !== null ||
              child.signalCode !== null
            ) {
              resolve();
              return;
            }
            child.once("close", () => resolve());
          }),
      ),
    );
  }
}

/**
 * Open a relay stream for the secretless proxy.
 *
 * The initial platform selector is consumed by the wrapper; every subsequent
 * byte is forwarded unchanged to/from the platform MCP child's stdio.
 */
export function connectClaudeMcpRelay(
  socketPath: string,
  platform: ClaudeMcpPlatform,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = (): void => {
      socket.off("error", onError);
      socket.off("data", onData);
      reject(new Error("Claude MCP relay closed before acknowledgement"));
    };
    const onConnect = (): void => {
      const handshake: RelayHandshake = { version: 1, platform };
      socket.write(`${JSON.stringify(handshake)}\n`);
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) {
        socket.destroy(new Error("invalid Claude MCP relay acknowledgement"));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline === -1) return;
      try {
        const value: unknown = JSON.parse(
          buffer.subarray(0, newline).toString("utf8"),
        );
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          (value as Record<string, unknown>).ok !== true
        ) {
          throw new Error("Claude MCP relay rejected the proxy");
        }
        const remainder = buffer.subarray(newline + 1);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("data", onData);
        if (remainder.length > 0) socket.unshift(remainder);
        resolve(socket);
      } catch (error) {
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("connect", onConnect);
    socket.on("data", onData);
  });
}
