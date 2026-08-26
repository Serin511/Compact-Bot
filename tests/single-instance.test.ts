/**
 * Tests for the single-instance lock module.
 *
 * Covers that a given (platform, token) pair can only be held by one live
 * process at a time: a second acquire on the same token is refused (null),
 * releasing frees it, distinct tokens are independent, and a stale socket
 * file left by a dead holder is reclaimed rather than blocking forever.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import {
  acquireInstanceLock,
  waitForInstanceLock,
} from "../src/single-instance.js";

let dir: string;

beforeEach(() => {
  // Short prefix: Unix socket paths are length-capped (~104 bytes on macOS).
  dir = mkdtempSync(join(tmpdir(), "cbl-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquireInstanceLock", () => {
  it("grants the lock to the first caller", async () => {
    const lock = await acquireInstanceLock("slack", "xapp-token", dir);
    expect(lock).not.toBeNull();
    lock!.release();
  });

  it("refuses a second acquire while the first is held", async () => {
    const first = await acquireInstanceLock("slack", "xapp-token", dir);
    const second = await acquireInstanceLock("slack", "xapp-token", dir);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    first!.release();
  });

  it("re-grants the lock after release", async () => {
    const first = await acquireInstanceLock("slack", "xapp-token", dir);
    first!.release();
    const second = await acquireInstanceLock("slack", "xapp-token", dir);
    expect(second).not.toBeNull();
    second!.release();
  });

  it("keeps distinct tokens independent", async () => {
    const a = await acquireInstanceLock("slack", "token-a", dir);
    const b = await acquireInstanceLock("slack", "token-b", dir);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!.release();
    b!.release();
  });

  it("keeps distinct platforms independent for the same token", async () => {
    const slack = await acquireInstanceLock("slack", "shared", dir);
    const discord = await acquireInstanceLock("discord", "shared", dir);
    expect(slack).not.toBeNull();
    expect(discord).not.toBeNull();
    slack!.release();
    discord!.release();
  });

  it("reclaims a stale socket file left by a dead holder", async () => {
    const first = await acquireInstanceLock("slack", "xapp-token", dir);
    const path = first!.path;
    first!.release();
    // Simulate a dead holder that left a non-listening file at the lock path.
    writeFileSync(path, "stale");
    const second = await acquireInstanceLock("slack", "xapp-token", dir);
    expect(second).not.toBeNull();
    second!.release();
  });

  it("grants exactly one owner when many callers reclaim a stale path", async () => {
    const first = await acquireInstanceLock("slack", "racy-token", dir);
    const path = first!.path;
    first!.release();
    writeFileSync(path, "stale");

    const contenders = await Promise.all(
      Array.from({ length: 20 }, () =>
        acquireInstanceLock("slack", "racy-token", dir)
      ),
    );
    const winners = contenders.filter((lock) => lock !== null);

    expect(winners).toHaveLength(1);
    winners[0]!.release();
  });

  it("reclaims through a later guard port when the first is unrelated", async () => {
    const first = await acquireInstanceLock("slack", "port-collision", dir);
    const path = first!.path;
    first!.release();
    writeFileSync(path, "stale");

    const digest = createHash("sha256")
      .update(`instance-reclaim\0${path}`)
      .digest();
    const firstGuardPort = 49_152 + (digest.readUInt16BE(0) % 16_384);
    const unrelated = net.createServer((socket) => socket.end("unrelated\n"));
    await new Promise<void>((resolve, reject) => {
      unrelated.once("error", reject);
      unrelated.listen(
        { host: "127.0.0.1", port: firstGuardPort, exclusive: true },
        () => resolve(),
      );
    });

    try {
      const lock = await acquireInstanceLock(
        "slack",
        "port-collision",
        dir,
      );
      expect(lock).not.toBeNull();
      lock!.release();
    } finally {
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
    }
  });

  it.each(["slack", "discord"])(
    "lets an inert %s peer take over after the owner releases without overlap",
    async (platform) => {
      const owner = await acquireInstanceLock(platform, "shared-token", dir);
      expect(owner).not.toBeNull();

      const abort = new AbortController();
      const successorPromise = waitForInstanceLock(
        platform,
        "shared-token",
        {
          dir,
          retryMs: 5,
          signal: abort.signal,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        await acquireInstanceLock(platform, "shared-token", dir),
      ).toBeNull();

      owner!.release();
      const successor = await Promise.race([
        successorPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("takeover timed out")), 1_000)
        ),
      ]);
      expect(successor).not.toBeNull();
      expect(
        await acquireInstanceLock(platform, "shared-token", dir),
      ).toBeNull();

      successor!.release();
      abort.abort();
    },
  );

  it("forces private directory and socket modes under umask 022", async () => {
    chmodSync(dir, 0o777);
    const previousUmask = process.umask(0o022);
    try {
      const lock = await acquireInstanceLock(
        "slack",
        "permission-token",
        dir,
      );
      expect(lock).not.toBeNull();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(lock!.path).mode & 0o777).toBe(0o600);
      lock!.release();
    } finally {
      process.umask(previousUmask);
    }
  });
});
