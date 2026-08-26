import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import {
  buildClaudeMcpServerSpec,
  buildCodexMcpProxyConfig,
  ClaudeMcpRelayServer,
  connectClaudeMcpRelay,
} from "../src/claude-mcp-relay.js";
import {
  mcpRuntimeValue,
  resetMcpRuntimeEnvironmentForTests,
} from "../src/mcp-runtime-environment.js";

interface FixtureEvent {
  event: string;
  pid: number;
  environment?: Record<string, string | undefined>;
  values?: Record<string, string>;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for relay fixture");
}

function roundTrip(socket: Socket, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.toString("utf8");
      if (received.length < request.length) return;
      cleanup();
      resolve(received);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("relay socket closed before fixture response"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.write(request);
  });
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("wrapper-owned Claude MCP relay", () => {
  const tempDirs: string[] = [];
  const relays: ClaudeMcpRelayServer[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(relays.splice(0).map((relay) => relay.close()));
    resetMcpRuntimeEnvironmentForTests();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "cb-mcpr-"));
    tempDirs.push(dir);
    return dir;
  }

  function readEvents(logPath: string): FixtureEvent[] {
    try {
      return readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FixtureEvent);
    } catch {
      return [];
    }
  }

  function createFixture(dir: string): {
    entrypoint: string;
    logPath: string;
  } {
    const entrypoint = join(dir, "fixture-mcp.mjs");
    const logPath = join(dir, "fixture-events.jsonl");
    writeFileSync(
      entrypoint,
      `import { appendFileSync, readFileSync } from "node:fs";
const runtimeFd = Number(process.env.COMPACT_BOT_MCP_RUNTIME_FD);
delete process.env.COMPACT_BOT_MCP_RUNTIME_FD;
const runtime = JSON.parse(readFileSync(runtimeFd, "utf8").trim());
const logPath = runtime.TEST_LOG_PATH;
const values = {
  DISCORD_BOT_TOKEN: runtime.DISCORD_BOT_TOKEN || "",
  SLACK_BOT_TOKEN: runtime.SLACK_BOT_TOKEN || "",
  COMPACT_BOT_IPC_AUTH_TOKEN: runtime.COMPACT_BOT_IPC_AUTH_TOKEN || "",
};
const ignoreShutdown = runtime.TEST_IGNORE_SHUTDOWN === "true";
if (ignoreShutdown) setInterval(() => {}, 1_000);
const record = (event) => appendFileSync(
  logPath,
  JSON.stringify({
    event,
    pid: process.pid,
    environment: {
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_APP_TOKEN: process.env.SLACK_APP_TOKEN,
      COMPACT_BOT_IPC_AUTH_TOKEN:
        process.env.COMPACT_BOT_IPC_AUTH_TOKEN,
      COMPACT_BOT_MCP_RUNTIME_FD:
        process.env.COMPACT_BOT_MCP_RUNTIME_FD,
    },
    values,
  }) + "\\n",
);
process.on("SIGTERM", () => {
  if (ignoreShutdown) {
    record("ignored-sigterm");
    return;
  }
  record("sigterm");
  process.exit(0);
});
record("start");
if (runtime.TEST_SPLIT_STDERR === "true") {
  const token = values.COMPACT_BOT_IPC_AUTH_TOKEN;
  process.stderr.write("diagnostic " + token.slice(0, 7));
  setTimeout(() => process.stderr.write(token.slice(7) + "\\n"), 5);
} else {
  process.stderr.write(
    "diagnostic " + values.COMPACT_BOT_IPC_AUTH_TOKEN + "\\n",
  );
}
process.stdin.on("data", (chunk) => {
  if (chunk.toString("utf8").includes('"method":"fixture/exit"')) {
    record("fixture-exit");
    process.exit(23);
  }
  process.stdout.write(chunk);
});
process.stdin.on("end", () => {
  if (ignoreShutdown) {
    record("ignored-stdin-end");
    return;
  }
  record("stdin-end");
  process.exit(0);
});
`,
      { mode: 0o700 },
    );
    return { entrypoint, logPath };
  }

  async function createRelay(
    dir: string,
    debug: string[] = [],
    limits: {
      maxConnections?: number;
      maxSessions?: number;
      maxSessionsPerPlatform?: number;
    } = {},
  ): Promise<{
    relay: ClaudeMcpRelayServer;
    relayPath: string;
    logPath: string;
  }> {
    const { entrypoint, logPath } = createFixture(dir);
    const relayPath = join(dir, "mcp.sock");
    const relay = await ClaudeMcpRelayServer.create(relayPath, {
      nodeExecutable: process.execPath,
      entrypoints: {
        discord: entrypoint,
        slack: entrypoint,
      },
      baseEnvironment: {
        ...process.env,
        DISCORD_BOT_TOKEN: "stale-discord-env",
        SLACK_BOT_TOKEN: "stale-slack-env",
        SLACK_APP_TOKEN: "stale-slack-app-env",
        COMPACT_BOT_IPC_AUTH_TOKEN: "stale-wrapper-env",
      },
      shutdownGraceMs: 250,
      ...limits,
      onDebug: (message) => debug.push(message),
      onError: (message, error) => {
        debug.push(`${message}: ${String(error)}`);
      },
    });
    relays.push(relay);
    return { relay, relayPath, logPath };
  }

  it("persists only a secretless stdio proxy reference in Claude local MCP JSON", () => {
    const spec = buildClaudeMcpServerSpec(
      "slack",
      "/opt/node/bin/node",
      "/opt/compact-bot/claude-mcp-proxy.js",
      "/private/compact-bot/data/mcp.sock",
    );
    const definition = JSON.parse(spec.json) as Record<string, unknown>;
    const serialized = JSON.stringify(definition);

    expect(spec.name).toBe("slack-bot");
    expect(definition).toEqual({
      command: "/opt/node/bin/node",
      args: [
        "/opt/compact-bot/claude-mcp-proxy.js",
        "slack",
        "/private/compact-bot/data/mcp.sock",
      ],
    });
    expect(definition).not.toHaveProperty("env");
    for (const forbidden of [
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "DISCORD_BOT_TOKEN",
      "COMPACT_BOT_IPC_AUTH_TOKEN",
      "xoxb-platform-secret",
      "wrapper-control-secret",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("builds Codex MCP config with a proxy and no forwarded env names", () => {
    expect(
      buildCodexMcpProxyConfig(
        "discord",
        "/opt/node/bin/node",
        "/opt/compact-bot/claude-mcp-proxy.js",
        "/private/compact-bot/data/mcp.sock",
      ),
    ).toEqual({
      name: "compact_bot_discord",
      command: "/opt/node/bin/node",
      args: [
        "/opt/compact-bot/claude-mcp-proxy.js",
        "discord",
        "/private/compact-bot/data/mcp.sock",
      ],
      envVars: [],
    });
  });

  it("loads the inherited runtime fd into memory without falling through to process env", () => {
    const dir = makeTempDir();
    const payloadPath = join(dir, "runtime.json");
    writeFileSync(
      payloadPath,
      JSON.stringify({
        DISCORD_BOT_TOKEN: "fd-only-token",
        EMPTY_OVERRIDE: "",
      }),
    );
    const fd = openSync(payloadPath, "r");
    const previousFd = process.env.COMPACT_BOT_MCP_RUNTIME_FD;
    const previousFallback = process.env.EMPTY_OVERRIDE;
    process.env.COMPACT_BOT_MCP_RUNTIME_FD = String(fd);
    process.env.EMPTY_OVERRIDE = "must-not-fall-through";
    try {
      expect(mcpRuntimeValue("DISCORD_BOT_TOKEN")).toBe("fd-only-token");
      expect(mcpRuntimeValue("EMPTY_OVERRIDE")).toBe("");
      expect(process.env.COMPACT_BOT_MCP_RUNTIME_FD).toBeUndefined();
    } finally {
      try {
        closeSync(fd);
      } catch {
        // The runtime loader closes inherited descriptors after consuming them.
      }
      if (previousFd === undefined) {
        delete process.env.COMPACT_BOT_MCP_RUNTIME_FD;
      } else {
        process.env.COMPACT_BOT_MCP_RUNTIME_FD = previousFd;
      }
      if (previousFallback === undefined) {
        delete process.env.EMPTY_OVERRIDE;
      } else {
        process.env.EMPTY_OVERRIDE = previousFallback;
      }
    }
  });

  it("injects secrets only over the wrapper-owned fd and relays MCP bytes verbatim", async () => {
    const dir = makeTempDir();
    const debug: string[] = [];
    const { relay, relayPath, logPath } = await createRelay(dir, debug);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-memory-only",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "wrapper-memory-only",
        AGENT_PROVIDER: "claude",
      },
    });

    const proxy = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(proxy);
    await waitFor(() =>
      readEvents(logPath).some((event) => event.event === "start")
    ).catch((error) => {
      throw new Error(`${String(error)}\n${debug.join("\n")}`);
    });
    const start = readEvents(logPath).find(
      (event) => event.event === "start",
    )!;
    expect(start.environment).toEqual({});
    expect(start.values).toMatchObject({
      DISCORD_BOT_TOKEN: "discord-memory-only",
      COMPACT_BOT_IPC_AUTH_TOKEN: "wrapper-memory-only",
    });

    const request =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n';
    const response = new Promise<string>((resolve) => {
      let received = "";
      proxy.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.length >= request.length) resolve(received);
      });
    });
    proxy.write(request.slice(0, 17));
    proxy.write(request.slice(17));
    await expect(response).resolves.toBe(request);

    expect(debug.join("\n")).not.toContain("wrapper-memory-only");
    expect(debug.join("\n")).toContain("[REDACTED]");
  });

  it("tears down a child with its proxy and starts a fresh child on reconnect", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });

    const first = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(first);
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 1,
    );
    const firstPid = readEvents(logPath).find(
      (event) => event.event === "start",
    )!.pid;
    first.destroy();
    await waitFor(() =>
      readEvents(logPath).some(
        (event) =>
          event.pid === firstPid &&
          (event.event === "sigterm" || event.event === "stdin-end"),
      )
    );
    await waitFor(() => isProcessGone(firstPid));

    const second = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(second);
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 2,
    );
    const starts = readEvents(logPath).filter(
      (event) => event.event === "start",
    );
    expect(starts[1].pid).not.toBe(firstPid);

    await relay.stopGeneration();
    await waitFor(() =>
      readEvents(logPath).some(
        (event) =>
          event.pid === starts[1].pid &&
          (event.event === "sigterm" || event.event === "stdin-end"),
      )
    );
  });

  it("serves concurrent same-platform MCP clients with isolated byte streams", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
      slack: {
        TEST_LOG_PATH: logPath,
        SLACK_BOT_TOKEN: "slack-secret",
        SLACK_APP_TOKEN: "slack-app-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });

    const [firstDiscord, secondDiscord, slack] = await Promise.all([
      connectClaudeMcpRelay(relayPath, "discord"),
      connectClaudeMcpRelay(relayPath, "discord"),
      connectClaudeMcpRelay(relayPath, "slack"),
    ]);
    sockets.push(firstDiscord, secondDiscord, slack);
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 3,
    );

    const firstRequest =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"first-discord"}}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"client":"first-discord"}}\n';
    const secondRequest =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"second-discord"}}\n' +
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"client":"second-discord"}}\n';
    const slackRequest =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"slack"}}\n';

    await expect(Promise.all([
      roundTrip(firstDiscord, firstRequest),
      roundTrip(secondDiscord, secondRequest),
      roundTrip(slack, slackRequest),
    ])).resolves.toEqual([firstRequest, secondRequest, slackRequest]);

    const starts = readEvents(logPath).filter(
      (event) => event.event === "start",
    );
    expect(new Set(starts.map((event) => event.pid)).size).toBe(3);
  });

  it("keeps sibling clients alive when one disconnects and stops all at generation end", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });

    const first = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(first);
    const firstInitialize =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"first"}}\n';
    await expect(roundTrip(first, firstInitialize)).resolves.toBe(
      firstInitialize,
    );
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 1,
    );
    const firstPid = readEvents(logPath).find(
      (event) => event.event === "start",
    )!.pid;

    const second = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(second);
    const secondInitialize =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"client":"second"}}\n';
    await expect(roundTrip(second, secondInitialize)).resolves.toBe(
      secondInitialize,
    );
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 2,
    );
    const secondPid = readEvents(logPath).filter(
      (event) => event.event === "start",
    )[1].pid;

    first.destroy();
    await waitFor(() => isProcessGone(firstPid));
    expect(isProcessGone(secondPid)).toBe(false);

    const siblingRequest =
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"client":"second"}}\n';
    await expect(roundTrip(second, siblingRequest)).resolves.toBe(
      siblingRequest,
    );

    await relay.stopGeneration();
    await waitFor(() => isProcessGone(secondPid));
  });

  it("bounds concurrent MCP children without returning to a single-platform lease", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir, [], {
      maxConnections: 4,
      maxSessions: 3,
      maxSessionsPerPlatform: 2,
    });
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
      slack: {
        TEST_LOG_PATH: logPath,
        SLACK_BOT_TOKEN: "slack-secret",
        SLACK_APP_TOKEN: "slack-app-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });

    const [firstDiscord, secondDiscord, firstSlack] = await Promise.all([
      connectClaudeMcpRelay(relayPath, "discord"),
      connectClaudeMcpRelay(relayPath, "discord"),
      connectClaudeMcpRelay(relayPath, "slack"),
    ]);
    sockets.push(firstDiscord, secondDiscord, firstSlack);
    await Promise.all([
      roundTrip(
        firstDiscord,
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
      ),
      roundTrip(
        secondDiscord,
        '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}\n',
      ),
      roundTrip(
        firstSlack,
        '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}\n',
      ),
    ]);
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 3,
    );

    await expect(
      connectClaudeMcpRelay(relayPath, "discord"),
    ).rejects.toThrow(/closed|capacity|acknowledgement/i);
    await expect(
      connectClaudeMcpRelay(relayPath, "slack"),
    ).rejects.toThrow(/closed|capacity|acknowledgement/i);
    expect(
      readEvents(logPath).filter((event) => event.event === "start"),
    ).toHaveLength(3);
  });

  it("bounds sockets that never complete the relay handshake", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir, [], {
      maxConnections: 2,
    });
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });

    const openWithoutHandshake = (): Promise<Socket> =>
      new Promise((resolve, reject) => {
        const socket = createConnection(relayPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    const [first, second] = await Promise.all([
      openWithoutHandshake(),
      openWithoutHandshake(),
    ]);
    first.on("error", () => {});
    second.on("error", () => {});
    sockets.push(first, second);

    await expect(
      connectClaudeMcpRelay(relayPath, "discord"),
    ).rejects.toThrow(/closed|capacity|acknowledgement|reset/i);
    expect(
      readEvents(logPath).filter((event) => event.event === "start"),
    ).toHaveLength(0);
  });

  it("awaits a SIGTERM-ignoring child before enabling the next generation", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        TEST_IGNORE_SHUTDOWN: "true",
        DISCORD_BOT_TOKEN: "first-generation-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "first-ipc-secret",
      },
    });
    const first = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(first);
    first.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );
    await waitFor(() =>
      readEvents(logPath).some((event) => event.event === "start")
    );
    const firstPid = readEvents(logPath).find(
      (event) => event.event === "start",
    )!.pid;

    const rolloverStartedAt = Date.now();
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "second-generation-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "second-ipc-secret",
      },
    });
    expect(Date.now() - rolloverStartedAt).toBeGreaterThanOrEqual(200);
    expect(isProcessGone(firstPid)).toBe(true);
    expect(
      readEvents(logPath).some(
        (event) =>
          event.pid === firstPid && event.event === "ignored-sigterm",
      ),
    ).toBe(true);

    const second = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(second);
    second.write(
      '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{}}\n',
    );
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 2,
    );
    const secondPid = readEvents(logPath).filter(
      (event) => event.event === "start",
    )[1].pid;
    expect(secondPid).not.toBe(firstPid);
  });

  it("closes a crashed child stream and creates a fresh MCP transport on reconnect", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });
    const first = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(first);
    first.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );
    await waitFor(() =>
      readEvents(logPath).some((event) => event.event === "start")
    );
    const closed = new Promise<void>((resolve) =>
      first.once("close", resolve)
    );
    first.write(
      '{"jsonrpc":"2.0","id":2,"method":"fixture/exit","params":{}}\n',
    );
    await closed;

    const second = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(second);
    second.write(
      '{"jsonrpc":"2.0","id":3,"method":"initialize","params":{}}\n',
    );
    await waitFor(
      () => readEvents(logPath).filter((event) => event.event === "start").length === 2,
    );
  });

  it("accepts a coalesced handshake and large initialize without altering MCP bytes", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });
    const raw = createConnection(relayPath);
    sockets.push(raw);
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(4_096) },
    }) + "\n";
    const response = new Promise<string>((resolve, reject) => {
      let received = "";
      raw.once("error", reject);
      raw.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        if (received.includes(initialize)) resolve(received);
      });
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", () => {
        raw.write(
          '{"version":1,"platform":"discord"}\n' + initialize,
        );
        resolve();
      });
      raw.once("error", reject);
    });
    await expect(response).resolves.toBe('{"ok":true}\n' + initialize);
  });

  it("redacts a token split across stderr chunks", async () => {
    const dir = makeTempDir();
    const debug: string[] = [];
    const { relay, relayPath, logPath } = await createRelay(dir, debug);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        TEST_SPLIT_STDERR: "true",
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "wrapper-split-secret",
      },
    });
    const proxy = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(proxy);
    proxy.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );
    await waitFor(() => debug.some((message) => message.includes("[REDACTED]")));
    const output = debug.join("\n");
    expect(output).not.toContain("wrapper-split-secret");
    expect(output).not.toContain("wrapper");
    expect(output).not.toContain("split-secret");
  });

  it("rejects a second relay without unlinking the live socket", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    await expect(
      ClaudeMcpRelayServer.create(relayPath, {
        nodeExecutable: process.execPath,
        entrypoints: {
          discord: join(dir, "missing-discord.mjs"),
          slack: join(dir, "missing-slack.mjs"),
        },
      }),
    ).rejects.toThrow(/already listening/);

    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });
    const proxy = await connectClaudeMcpRelay(relayPath, "discord");
    sockets.push(proxy);
    proxy.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n',
    );
    await waitFor(() =>
      readEvents(logPath).some((event) => event.event === "start")
    );
  });

  it("closes promptly with an idle handshake connection and a live child", async () => {
    const dir = makeTempDir();
    const { relay, relayPath, logPath } = await createRelay(dir);
    // Remove from afterEach ownership because this test closes explicitly.
    relays.splice(relays.indexOf(relay), 1);
    await relay.startGeneration({
      discord: {
        TEST_LOG_PATH: logPath,
        DISCORD_BOT_TOKEN: "discord-secret",
        WRAPPER_SOCKET: join(dir, "wrapper.sock"),
        COMPACT_BOT_IPC_AUTH_TOKEN: "ipc-secret",
      },
    });
    const proxy = await connectClaudeMcpRelay(relayPath, "discord");
    const idle = createConnection(relayPath);
    sockets.push(proxy, idle);
    await new Promise<void>((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });
    await waitFor(() =>
      readEvents(logPath).some((event) => event.event === "start")
    );

    const startedAt = Date.now();
    await relay.close();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("uses a relay socket name below the macOS UDS limit whenever wrapper.sock fits", async () => {
    const base = makeTempDir();
    const fixedBytes = Buffer.byteLength(join(base, "mcp.sock"));
    const paddingLength = Math.max(1, 100 - fixedBytes - 1);
    const dataDir = join(base, "x".repeat(paddingLength));
    mkdirSync(dataDir);
    const relayPath = join(dataDir, "mcp.sock");
    const wrapperPath = join(dataDir, "wrapper.sock");
    const { entrypoint } = createFixture(base);

    expect(Buffer.byteLength(relayPath)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(relayPath)).toBeLessThan(
      Buffer.byteLength(wrapperPath),
    );
    const relay = await ClaudeMcpRelayServer.create(relayPath, {
      nodeExecutable: process.execPath,
      entrypoints: { discord: entrypoint, slack: entrypoint },
    });
    relays.push(relay);
    expect(relay.socketPath).toBe(relayPath);
  });
});
