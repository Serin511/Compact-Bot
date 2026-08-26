import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, type Server } from "node:net";
import {
  connectToWrapper,
  createIpcServer,
  type JsonLineSocket,
} from "../src/ipc.js";

describe("createIpcServer", () => {
  let dir: string;
  let socketPath: string;
  const servers: Server[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-ipc-"));
    socketPath = join(dir, "wrapper.sock");
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      ),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("reclaims a stale path and creates a private control socket", async () => {
    writeFileSync(socketPath, "stale");
    const server = await createIpcServer(socketPath, () => {});
    servers.push(server);

    expect(server.listening).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  });

  it("fails fast without unlinking a live wrapper socket", async () => {
    const first = await createIpcServer(socketPath, () => {});
    servers.push(first);

    await expect(createIpcServer(socketPath, () => {})).rejects.toThrow(
      /already listening|already starting/,
    );
    expect(first.listening).toBe(true);
    expect(statSync(socketPath).isSocket()).toBe(true);
  });

  it("allows exactly one concurrent wrapper to reclaim a stale path", async () => {
    writeFileSync(socketPath, "stale");
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        createIpcServer(socketPath, () => {})
      ),
    );
    const winners = attempts
      .filter(
        (attempt): attempt is PromiseFulfilledResult<Server> =>
          attempt.status === "fulfilled",
      )
      .map((attempt) => attempt.value);
    servers.push(...winners);

    expect(winners).toHaveLength(1);
    expect(winners[0].listening).toBe(true);
  });

  it("accepts authenticated peers and strips the transport credential", async () => {
    let resolveMessage!: (message: Record<string, unknown>) => void;
    const received = new Promise<Record<string, unknown>>((resolve) => {
      resolveMessage = resolve;
    });
    const server = await createIpcServer(
      socketPath,
      (client) => client.once("message", resolveMessage),
      { authToken: "test-secret" },
    );
    servers.push(server);
    const peer = await connectToWrapper(socketPath, "test-secret");
    peer.send({
      type: "ready",
      source: "slack",
    });

    await expect(received).resolves.toEqual({
      type: "ready",
      source: "slack",
    });
    peer.destroy();
  });

  it("rejects an unauthenticated peer before dispatching its message", async () => {
    let dispatched = false;
    const server = await createIpcServer(
      socketPath,
      (client) => client.on("message", () => {
        dispatched = true;
      }),
      { authToken: "test-secret" },
    );
    servers.push(server);

    const closed = new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath, () => {
        socket.write('{"type":"ready","source":"slack"}\n');
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    await closed;
    expect(dispatched).toBe(false);
  });

  it("closes a peer whose unterminated line exceeds the configured cap", async () => {
    let client: JsonLineSocket | undefined;
    const server = await createIpcServer(
      socketPath,
      (connected) => {
        client = connected;
      },
      { maxLineBytes: 32 },
    );
    servers.push(server);

    const closed = new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath, () => {
        socket.write("x".repeat(33));
      });
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    await closed;
    expect(client).toBeDefined();
  });
});
