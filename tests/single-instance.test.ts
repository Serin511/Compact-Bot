/**
 * Tests for the single-instance lock module.
 *
 * Covers that a given (platform, token) pair can only be held by one live
 * process at a time: a second acquire on the same token is refused (null),
 * releasing frees it, distinct tokens are independent, and a stale socket
 * file left by a dead holder is reclaimed rather than blocking forever.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../src/single-instance.js";

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
});
