import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("command help", () => {
  it("shows the usable Discord and Slack command prefixes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "compact-bot-help-"));
    const modulePath = resolve("src", "messages.ts");
    const tsxLoader = resolve("node_modules", "tsx", "dist", "loader.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        "--eval",
        `const { msg } = await import(${JSON.stringify(modulePath)}); console.log(msg("help"));`,
      ],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(cwd, "xdg"),
        },
      },
    );
    rmSync(cwd, { recursive: true, force: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("`/new`");
    expect(result.stdout).toContain("`!new`");
    expect(result.stdout).toContain("`/capture [--all]`");
    expect(result.stdout).toContain("`!capture [--all]`");
  });

  it("uses the inherited fd runtime provider before rendering Codex help", () => {
    const cwd = mkdtempSync(join(tmpdir(), "compact-bot-help-runtime-"));
    const modulePath = resolve("src", "messages.ts");
    const tsxLoader = resolve("node_modules", "tsx", "dist", "loader.mjs");
    const runtimePayloadPath = join(cwd, "runtime.json");
    writeFileSync(
      runtimePayloadPath,
      JSON.stringify({ AGENT_PROVIDER: "codex" }),
      { mode: 0o600 },
    );
    const runtimeFd = openSync(runtimePayloadPath, "r");
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(
        process.execPath,
        [
          "--import",
          tsxLoader,
          "--eval",
          `const { msg } = await import(${JSON.stringify(modulePath)}); console.log(msg("help"));`,
        ],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            AGENT_PROVIDER: "claude",
            COMPACT_BOT_MCP_RUNTIME_FD: "3",
            XDG_CONFIG_HOME: join(cwd, "xdg"),
          },
          stdio: ["ignore", "pipe", "pipe", runtimeFd],
        },
      );
    } finally {
      closeSync(runtimeFd);
      rmSync(cwd, { recursive: true, force: true });
    }

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Codex 모델");
    expect(result.stdout).toContain("reasoning effort 조회/변경");
    expect(result.stdout).toContain("최신 512 KiB");
    expect(result.stdout).not.toContain("CLI 화면 캡처");
  });
});
