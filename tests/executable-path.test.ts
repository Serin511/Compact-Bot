import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executableOnPath,
  resolveCodexExecutable,
} from "../src/executable-path.js";

describe("executableOnPath", () => {
  it("finds an executable without invoking a shell", () => {
    const first = mkdtempSync(join(tmpdir(), "cb-path-first-"));
    const second = mkdtempSync(join(tmpdir(), "cb-path-second-"));
    const executable = join(second, "codex-test");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    try {
      expect(
        executableOnPath(
          "codex-test",
          `${first}${delimiter}${second}`,
        ),
      ).toBe(executable);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it("does not interpret shell metacharacters", () => {
    expect(executableOnPath("codex; touch exploited", process.env.PATH)).toBe(
      null,
    );
  });

  it("leaves explicit paths to the caller", () => {
    expect(executableOnPath("/usr/bin/true", process.env.PATH)).toBeNull();
  });

  it("skips a broken PATH shim for a working app bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-codex-resolve-"));
    const pathDir = join(root, "path");
    const brokenShim = join(pathDir, "codex");
    const bundled = join(root, "Codex.app", "codex");
    mkdirSync(pathDir);
    mkdirSync(join(root, "Codex.app"));
    writeFileSync(brokenShim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(bundled, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    try {
      expect(
        resolveCodexExecutable("codex", {
          pathValue: pathDir,
          appCandidates: [bundled],
          validate: (candidate) => candidate === bundled,
        }),
      ).toBe(bundled);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("freezes an explicit relative path against the launch cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-codex-relative-"));
    const executable = join(root, "codex-test");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    try {
      expect(
        resolveCodexExecutable("./codex-test", {
          cwd: root,
          validate: (candidate) => candidate === executable,
        }),
      ).toBe(executable);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues through PATH after a broken executable shim", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-codex-path-chain-"));
    const first = join(root, "first");
    const second = join(root, "second");
    const brokenShim = join(first, "codex");
    const workingExecutable = join(second, "codex");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(brokenShim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(workingExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    try {
      expect(
        resolveCodexExecutable("codex", {
          pathValue: `${first}${delimiter}${second}`,
          appCandidates: [],
          validate: (candidate) => candidate === workingExecutable,
        }),
      ).toBe(workingExecutable);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
