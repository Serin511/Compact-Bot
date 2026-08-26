/**
 * Tests for ``safeAttName`` and ``isSendablePath`` from src/sanitize.ts.
 *
 * Covers delimiter scrubbing for forge-resistance, fallback handling for
 * empty/null filenames, and the explicit workspace boundary that prevents
 * the reply tool from leaking arbitrary host files.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AttachmentDownloadPool,
  downloadAttachmentToFile,
  isSendablePath,
  pruneAttachmentStorage,
  readResponseBuffer,
  readSendableFile,
  resolveContainedPath,
  safeAttName,
} from "../src/sanitize.js";
import { CONFIG_HOME, DATA_DIR } from "../src/paths.js";

describe("safeAttName", () => {
  it("replaces delimiter characters with underscores", () => {
    expect(safeAttName("hello[world]\n;done")).toBe("hello_world___done");
  });

  it("returns the fallback for null/empty input", () => {
    expect(safeAttName(null, "fallback")).toBe("fallback");
    expect(safeAttName("", "fallback")).toBe("fallback");
    expect(safeAttName("   ", "fallback")).toBe("fallback");
  });

  it("uses the default fallback when none provided", () => {
    expect(safeAttName(null)).toBe("file");
  });

  it("preserves benign characters", () => {
    expect(safeAttName("image (1).png")).toBe("image (1).png");
  });

  it("removes POSIX and Windows path traversal from remote filenames", () => {
    expect(safeAttName("../../secret.txt")).toBe(".._.._secret.txt");
    expect(safeAttName("..\\..\\.env")).toBe(".._.._.env");
    expect(safeAttName("..", "fallback.txt")).toBe("fallback.txt");
  });

  it("sanitizes a fallback identifier before using it as a filename", () => {
    expect(safeAttName(null, "../../fallback")).toBe(".._.._fallback");
  });
});

describe("resolveContainedPath", () => {
  const root = join(tmpdir(), "compact-bot-contained-path");

  it("resolves a normal child inside the requested directory", () => {
    expect(resolveContainedPath(root, "safe.txt")).toBe(join(root, "safe.txt"));
  });

  it("rejects relative and absolute paths outside the requested directory", () => {
    expect(() => resolveContainedPath(root, "../secret.txt")).toThrow(/escapes/);
    expect(() =>
      resolveContainedPath(root, join(dirname(root), "secret.txt"))
    ).toThrow(/escapes/);
    expect(() => resolveContainedPath(root, ".")).toThrow(/escapes/);
  });
});

describe("attachment storage limits", () => {
  const root = join(
    tmpdir(),
    `compact-bot-attachment-prune-${process.pid}`,
  );

  it("removes entries older than the retention window", () => {
    const now = Date.now();
    const oldDir = join(root, "old-message");
    const freshDir = join(root, "fresh-message");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(freshDir, { recursive: true });
    const oldFile = join(oldDir, "old.txt");
    const freshFile = join(freshDir, "fresh.txt");
    writeFileSync(oldFile, "old");
    writeFileSync(freshFile, "fresh");
    const oldTime = new Date(now - 10_000);
    const freshTime = new Date(now - 100);
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(oldDir, oldTime, oldTime);
    utimesSync(freshFile, freshTime, freshTime);
    utimesSync(freshDir, freshTime, freshTime);

    try {
      pruneAttachmentStorage(root, { maxAgeMs: 1_000, now });
      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(freshDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts the oldest entries to reserve space under the byte cap", () => {
    const now = Date.now();
    mkdirSync(root, { recursive: true });
    const oldest = join(root, "oldest.bin");
    const newest = join(root, "newest.bin");
    writeFileSync(oldest, Buffer.alloc(4));
    writeFileSync(newest, Buffer.alloc(4));
    const oldTime = new Date(now - 2_000);
    const newTime = new Date(now - 1_000);
    utimesSync(oldest, oldTime, oldTime);
    utimesSync(newest, newTime, newTime);

    try {
      pruneAttachmentStorage(root, {
        maxAgeMs: 10_000,
        maxBytes: 8,
        reserveBytes: 4,
        now,
      });
      expect(existsSync(oldest)).toBe(false);
      expect(existsSync(newest)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a response body that exceeds its streaming byte limit", async () => {
    await expect(
      readResponseBuffer(new Response(Buffer.alloc(5)), 4),
    ).rejects.toThrow(/exceeds 4 bytes/);
  });

  it("times out a response body that never finishes", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("partial"));
      },
    });
    await expect(
      readResponseBuffer(new Response(body), 100, 10),
    ).rejects.toThrow(/timed out/);
  });
});

describe("bounded attachment downloads", () => {
  const root = join(
    tmpdir(),
    `compact-bot-attachment-download-${process.pid}`,
  );

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("bounds both active tasks and the waiting queue", async () => {
    const pool = new AttachmentDownloadPool(1, 1);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = pool.run(async () => {
      await firstGate;
      return "first";
    });
    const second = pool.run(async () => "second");

    await expect(
      pool.run(async () => "overflow"),
    ).rejects.toThrow(/queue is full/);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("atomically publishes a complete private download", async () => {
    mkdirSync(root, { recursive: true });
    const destination = join(root, "result.bin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("complete"), { status: 200 }),
    );

    await expect(
      downloadAttachmentToFile(
        "https://cdn.example/result.bin",
        destination,
        100,
      ),
    ).resolves.toBe(8);
    expect(readFileSync(destination, "utf-8")).toBe("complete");
    expect((readFileSync(destination).byteLength)).toBe(8);
  });

  it("aborts a stalled fetch and leaves no destination file", async () => {
    mkdirSync(root, { recursive: true });
    const destination = join(root, "stalled.bin");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    await expect(
      downloadAttachmentToFile(
        "https://cdn.example/stalled.bin",
        destination,
        100,
        {},
        10,
      ),
    ).rejects.toThrow(/timed out/);
    expect(existsSync(destination)).toBe(false);
  });

  it("does not publish a body that exceeds its streamed byte cap", async () => {
    mkdirSync(root, { recursive: true });
    const destination = join(root, "oversize.bin");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.alloc(5), { status: 200 }),
    );

    await expect(
      downloadAttachmentToFile(
        "https://cdn.example/oversize.bin",
        destination,
        4,
      ),
    ).rejects.toThrow(/exceeds 4 bytes/);
    expect(existsSync(destination)).toBe(false);
  });
});

describe("isSendablePath", () => {
  const outsideTmp = join(tmpdir(), `compact-bot-test-${Date.now()}`);

  it("accepts paths inside an explicit workspace root", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const f = join(outsideTmp, "okay.txt");
    writeFileSync(f, "ok");
    try {
      expect(isSendablePath(f, [outsideTmp])).toBe(true);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("snapshots bytes before a validated path can be replaced", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const requested = join(outsideTmp, "report.txt");
    const original = join(outsideTmp, "original.txt");
    const secret = join(outsideTmp, "secret.txt");
    writeFileSync(requested, "safe report");
    writeFileSync(secret, "secret value");
    try {
      const snapshot = readSendableFile(requested, [outsideTmp], 1_000);
      renameSync(requested, original);
      symlinkSync(secret, requested);

      expect(snapshot.data.toString("utf-8")).toBe("safe report");
      expect(snapshot.filename).toBe("report.txt");
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("rejects readable paths outside explicit workspace roots", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const workspace = join(outsideTmp, "workspace");
    const secret = join(outsideTmp, "secret.txt");
    mkdirSync(workspace);
    writeFileSync(secret, "secret");
    try {
      expect(isSendablePath(secret, [workspace])).toBe(false);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("rejects symlinks that escape an explicit workspace root", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const workspace = join(outsideTmp, "workspace");
    const secret = join(outsideTmp, "secret.txt");
    const link = join(workspace, "escape.txt");
    mkdirSync(workspace);
    writeFileSync(secret, "secret");
    symlinkSync(secret, link);
    try {
      expect(isSendablePath(link, [workspace])).toBe(false);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("rejects dotenv secrets inside an allowed workspace", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const envFile = join(outsideTmp, ".env.production");
    writeFileSync(envFile, "TOKEN=should-not-leak");
    try {
      expect(isSendablePath(envFile, [outsideTmp])).toBe(false);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("rejects a disguised symlink to a dotenv secret", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const envFile = join(outsideTmp, ".env");
    const link = join(outsideTmp, "safe-looking.txt");
    writeFileSync(envFile, "TOKEN=should-not-leak");
    symlinkSync(envFile, link);
    try {
      expect(isSendablePath(link, [outsideTmp])).toBe(false);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("accepts paths inside the attachments inbox", () => {
    const attachmentsDir = join(DATA_DIR, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    const f = join(attachmentsDir, "incoming.png");
    writeFileSync(f, "data");
    try {
      expect(isSendablePath(f)).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("rejects paths inside CONFIG_HOME but outside attachments", () => {
    mkdirSync(CONFIG_HOME, { recursive: true });
    const f = join(CONFIG_HOME, "secret.env.test");
    writeFileSync(f, "TOKEN=should-not-leak");
    try {
      expect(isSendablePath(f, [CONFIG_HOME])).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("rejects non-existent paths", () => {
    expect(isSendablePath("/nonexistent/path/that/does/not/exist")).toBe(false);
  });

  it("rejects directories even when they are inside the workspace", () => {
    mkdirSync(outsideTmp, { recursive: true });
    try {
      expect(isSendablePath(outsideTmp, [outsideTmp])).toBe(false);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });
});
