/**
 * Cross-process single-instance lock keyed by platform + connection token.
 *
 * A single Slack `SLACK_APP_TOKEN` (or Discord bot token) must have exactly
 * one live realtime connection. Slack Socket Mode round-robins each event
 * across every connected socket for an app token, so a duplicate connection
 * silently steals a share of incoming messages and drops them. Duplicates
 * arise easily: a second `npx compact-bot` run, or a Claude Code / VSCode
 * session that has `slack-mcp-server.js` registered as an MCP server and
 * auto-spawns another copy pointed at the same token.
 *
 * The lock is a listening Unix domain socket whose filename is derived from
 * the token hash. Only one process can listen on a given path; the OS frees
 * the socket automatically when the holder dies, so a crash never leaves the
 * token permanently locked. A leftover socket file from an unclean exit is
 * reclaimed by probing it (connect) and, on refusal, unlinking and retrying.
 *
 * Exports:
 *   acquireInstanceLock — try to become the sole holder for a token.
 *   InstanceLock — handle with `path` and `release()`.
 *
 * Example:
 *   >>> const lock = await acquireInstanceLock("slack", process.env.SLACK_APP_TOKEN!);
 *   >>> if (!lock) skipRealtimeConnection();
 */

import net from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR } from "./paths.js";
import { acquireLoopbackGuard } from "./loopback-guard.js";

/** Handle to an acquired single-instance lock. */
export interface InstanceLock {
  /** Filesystem path of the lock socket. */
  path: string;
  /** Release the lock (close the socket and remove its file). */
  release(): void;
}

/**
 * Attempt to listen on a Unix socket path.
 *
 * @param path - Socket path to bind.
 * @returns The listening server on success, or null if the path is in use
 *   (EADDRINUSE) or binding otherwise failed.
 */
function tryListen(path: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(null));
    server.listen(path, () => {
      try {
        // Unix sockets inherit the process umask and are commonly created as
        // 0755. The lock is also a liveness endpoint, so keep it private even
        // when compact-bot is launched under the usual umask 022.
        chmodSync(path, 0o600);
      } catch {
        server.close();
        try {
          if (existsSync(path)) unlinkSync(path);
        } catch {
          // ignore cleanup failure; acquisition still failed
        }
        resolve(null);
        return;
      }
      server.removeAllListeners("error");
      resolve(server);
    });
  });
}

/**
 * Probe whether a live process is listening on the given socket path.
 *
 * @param path - Socket path to connect to.
 * @returns True if a connection succeeds (a holder is alive), false if the
 *   file is stale (connection refused / missing).
 */
function probe(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(path);
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => {
      conn.destroy();
      resolve(false);
    });
  });
}

/**
 * Serialize stale Unix-socket reclamation with an OS-owned TCP listener.
 *
 * A plain probe → unlink → listen sequence is racy: concurrent contenders can
 * all observe the stale path and then unlink each other's newly-bound socket.
 * The loopback listener is only held around that cleanup window. Unlike a file
 * lock it disappears automatically if the cleaner crashes.
 *
 * Several deterministic ports are tried so an unrelated loopback service
 * cannot permanently block takeover. A short handshake distinguishes an
 * active cleaner for this exact socket from an unrelated port occupant.
 */
async function tryAcquireReclaimGuard(
  path: string,
): Promise<net.Server | null> {
  return await acquireLoopbackGuard(`instance-reclaim\0${path}`);
}

/**
 * Acquire the sole-instance lock for a platform + token pair.
 *
 * @param platform - Short platform tag (e.g. "slack", "discord"), namespacing
 *   the lock so the same token on different platforms does not collide.
 * @param token - The connection token whose realtime connection must be unique.
 * @param dir - Directory to store the lock socket (defaults to the runtime
 *   data dir). Overridable for tests.
 * @returns An {@link InstanceLock} if this process is now the sole holder, or
 *   null if another live process already holds it.
 */
export async function acquireInstanceLock(
  platform: string,
  token: string,
  dir: string = DATA_DIR,
): Promise<InstanceLock | null> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // Keep the filename short: Unix socket paths are capped (~104 bytes on
  // macOS) and this sits under a possibly-deep data dir. 12 hex chars of the
  // token hash (48 bits) is ample to avoid collisions across tokens.
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 12);
  const path = join(dir, `cb-${platform}-${hash}.sock`);

  let server = await tryListen(path);
  if (!server) {
    // Path in use: distinguish a live holder from a stale leftover file.
    const alive = await probe(path);
    if (alive) return null;

    const reclaimGuard = await tryAcquireReclaimGuard(path);
    if (!reclaimGuard) return null;
    try {
      // Another contender may have completed reclamation while this caller was
      // waiting for the guard. Never unlink a newly-live owner's socket.
      if (await probe(path)) return null;
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // If we cannot clear it, treat the token as taken.
        return null;
      }
      server = await tryListen(path);
      if (!server) return null;
    } finally {
      reclaimGuard.close();
    }
  }

  const held = server;
  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      try {
        held.close();
      } catch {
        // ignore
      }
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // ignore
      }
    },
  };
}

export interface WaitForInstanceLockOptions {
  /** Directory containing the lock socket. Overridable for tests. */
  dir?: string;
  /** Delay between probes while another process owns the lock. */
  retryMs?: number;
  /** Stops a pending takeover attempt during MCP shutdown. */
  signal?: AbortSignal;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wait until this process can take over a platform's realtime lock.
 *
 * An inert Codex MCP child calls this in the background. When the current
 * owner exits, its listening socket disappears and exactly one contender
 * acquires the path; all others keep waiting. The abort signal makes the
 * otherwise long-lived poll safe to stop during process shutdown.
 */
export async function waitForInstanceLock(
  platform: string,
  token: string,
  options: WaitForInstanceLockOptions = {},
): Promise<InstanceLock | null> {
  const retryMs = Math.max(1, options.retryMs ?? 1_000);
  while (!options.signal?.aborted) {
    const lock = await acquireInstanceLock(platform, token, options.dir);
    if (lock) return lock;
    if (!(await waitForRetry(retryMs, options.signal))) return null;
  }
  return null;
}
