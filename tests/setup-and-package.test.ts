import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import dotenv from "dotenv";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureSecureConfigHome,
  PromptSession,
  serializeEnvValue,
  writeSecureEnvFile,
} from "../src/init.js";
import {
  ensureNodePtySpawnHelperExecutable,
  resolveNodePtyPackageRoot,
} from "../scripts/fix-node-pty-permissions.mjs";
import { parseMaxTurns } from "../src/turn-limit.js";

const temporaryPaths: string[] = [];

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("interactive setup security", () => {
  it("does not echo secret answers", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });

    const prompts = new PromptSession(input, output, true);
    const answer = prompts.askSecret("Bot token");
    input.write("sensitive-token\n");

    await expect(answer).resolves.toBe("sensitive-token");
    expect(rendered).toContain("Bot token");
    expect(rendered).not.toContain("sensitive-token");
    prompts.close();
  });

  it("rejects cleanly when interactive input reaches EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompts = new PromptSession(input, output, false);
    const answer = prompts.ask("Agent", "claude");

    input.end();

    await expect(answer).rejects.toThrow("Interactive input was closed");
    prompts.close();
  });

  it("creates owner-only config and environment files", () => {
    const root = makeTempDir("compact-bot-init-");
    const configHome = join(root, "config");
    const envPath = join(configHome, ".env");

    ensureSecureConfigHome(configHome);
    writeFileSync(envPath, "old", { mode: 0o644 });
    writeSecureEnvFile(envPath, "TOKEN=secret\n");

    if (process.platform !== "win32") {
      expect(statSync(configHome).mode & 0o777).toBe(0o700);
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    }
  });

  it.each([
    "",
    "plain-value",
    "/tmp/project with spaces",
    "/tmp/project#1",
    String.raw`C:\Users\serin\Codex#beta`,
    "O'Brien #1",
    "quotes 'and' `ticks` #1",
  ])("round-trips generated dotenv values exactly: %s", (value) => {
    const parsed = dotenv.parse(`VALUE=${serializeEnvValue(value)}\n`);
    expect(parsed.VALUE).toBe(value);
  });

  it("rejects multiline values instead of writing an injectable env entry", () => {
    expect(() => serializeEnvValue("safe\nINJECTED=true")).toThrow(
      "must be a single line",
    );
  });
});

describe("node-pty installation", () => {
  it("resolves the hoisted node-pty package", () => {
    expect(resolveNodePtyPackageRoot()).toBe(
      resolve("node_modules", "node-pty"),
    );
  });

  it("repairs the active macOS spawn-helper mode", () => {
    const packageRoot = makeTempDir("compact-bot-node-pty-");
    const helperDir = join(packageRoot, "prebuilds", "darwin-arm64");
    const helperPath = join(helperDir, "spawn-helper");
    mkdirSync(helperDir, { recursive: true });
    writeFileSync(helperPath, "#!/bin/sh\n", { mode: 0o644 });

    expect(
      ensureNodePtySpawnHelperExecutable({
        packageRoot,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe(helperPath);
    expect(statSync(helperPath).mode & 0o777).toBe(0o755);
  });

  it("reports a missing macOS spawn-helper instead of hiding it", () => {
    const packageRoot = makeTempDir("compact-bot-node-pty-missing-");
    expect(() =>
      ensureNodePtySpawnHelperExecutable({
        packageRoot,
        platform: "darwin",
        arch: "arm64",
      }),
    ).toThrow(/spawn-helper was not found/);
  });
});

describe("CLI arguments", () => {
  const cli = resolve("src", "cli.ts");

  function runCli(...args: string[]) {
    return spawnSync(
      process.execPath,
      ["--import", "tsx", cli, ...args],
      { cwd: process.cwd(), encoding: "utf8" },
    );
  }

  it("prints help without loading bot configuration", () => {
    const result = runCli("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: compact-bot");
    expect(result.stderr).not.toContain("Missing required environment");
  });

  it("prints the package version", () => {
    const expectedVersion = execFileSync(process.execPath, [
        "-e",
        "process.stdout.write(require('./package.json').version)",
      ]).toString();
    const result = runCli("--version");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedVersion);
  });

  it("rejects unknown arguments without starting the bot", () => {
    const result = runCli("--definitely-unknown");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command or arguments");
  });

  it("exits cleanly when init receives EOF", () => {
    const cwd = makeTempDir("compact-bot-init-eof-");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", cli, "init"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        input: "",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(cwd, "xdg"),
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("입력이 종료되어");
    expect(result.stderr).not.toContain("unsettled top-level await");
  });
});

describe("configuration loading", () => {
  function loadConfig(
    overrides: Record<string, string>,
    localEnv?: string,
  ) {
    const cwd = makeTempDir("compact-bot-config-");
    if (localEnv !== undefined) {
      writeFileSync(join(cwd, ".env"), localEnv, { mode: 0o600 });
    }
    const tsxLoader = resolve("node_modules", "tsx", "dist", "loader.mjs");
    const script = [
      `const config = await import(${JSON.stringify(resolve("src", "config.ts"))});`,
      "console.log(JSON.stringify({",
      "discordOperators: config.config.discordOperatorUserIds,",
      "slackOperators: config.config.slackOperatorUserIds,",
      "}));",
    ].join("");
    return spawnSync(
      process.execPath,
      ["--import", tsxLoader, "--eval", script],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(cwd, "xdg"),
          DISCORD_BOT_TOKEN: "",
          SLACK_BOT_TOKEN: "",
          SLACK_APP_TOKEN: "",
          ...overrides,
        },
      },
    );
  }

  it("requires Slack bot and app tokens together", () => {
    const missingApp = loadConfig({
      DISCORD_BOT_TOKEN: "discord",
      SLACK_BOT_TOKEN: "xoxb-test",
    });
    expect(missingApp.status).toBe(1);
    expect(missingApp.stderr).toContain(
      "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set together",
    );

    const missingBot = loadConfig({
      DISCORD_BOT_TOKEN: "discord",
      SLACK_APP_TOKEN: "xapp-test",
    });
    expect(missingBot.status).toBe(1);
    expect(missingBot.stderr).toContain(
      "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set together",
    );
  });

  it("does not print dotenv diagnostics to stdout", () => {
    const result = loadConfig({
      DISCORD_BOT_TOKEN: "discord",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("[dotenv@");
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("parses optional operator IDs", () => {
    const result = loadConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      DISCORD_OPERATOR_USER_IDS: "1, 2",
      SLACK_OPERATOR_USER_IDS: "U1, U2",
    });
    expect(result.status).toBe(0);
    const output = result.stdout.trim().split(/\r?\n/).at(-1);
    expect(JSON.parse(output ?? "")).toEqual({
      discordOperators: ["1", "2"],
      slackOperators: ["U1", "U2"],
    });
  });

  it.each(["abc", "-1", "1.5", "9007199254740992"])(
    "rejects invalid MAX_TURNS instead of silently treating %s as unlimited",
    (value) => {
      const result = loadConfig({
        DISCORD_BOT_TOKEN: "discord",
        MAX_TURNS: value,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid MAX_TURNS");
    },
  );

  it("ignores MAX_TURNS validation in Codex mode", () => {
    const result = loadConfig({
      AGENT_PROVIDER: "codex",
      DISCORD_BOT_TOKEN: "discord",
      MAX_TURNS: "not-used-by-codex",
    });
    expect(result.status).toBe(0);
  });

  it("rejects platform credentials from a Codex-readable local dotenv file", () => {
    const result = loadConfig(
      {
        AGENT_PROVIDER: "codex",
      },
      [
        "AGENT_PROVIDER=codex",
        "DISCORD_BOT_TOKEN=workspace-secret",
        "",
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Codex mode refuses platform credentials",
    );
    expect(result.stderr).toContain("compact-bot init");
    expect(result.stderr).not.toContain("workspace-secret");
  });

  it("accepts zero and positive integer turn limits", () => {
    expect(parseMaxTurns("0")).toBe(0);
    expect(parseMaxTurns("50")).toBe(50);
    expect(parseMaxTurns(" 12 ")).toBe(12);
  });

  it("honors an explicitly empty system prompt path over a stale config file", () => {
    const cwd = makeTempDir("compact-bot-config-prompt-");
    const xdgHome = join(cwd, "xdg");
    const configHome = join(xdgHome, "compact-bot");
    mkdirSync(configHome, { recursive: true });
    writeFileSync(
      join(configHome, "system-prompt.txt"),
      "STALE_PROMPT_MUST_NOT_LOAD",
    );
    const tsxLoader = resolve("node_modules", "tsx", "dist", "loader.mjs");
    const script = [
      `const loaded = await import(${JSON.stringify(resolve("src", "config.ts"))});`,
      "console.log(JSON.stringify({",
      "path: loaded.config.systemPromptPath,",
      "prompt: loaded.loadSystemPrompt(),",
      "}));",
    ].join("");
    const result = spawnSync(
      process.execPath,
      ["--import", tsxLoader, "--eval", script],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: xdgHome,
          DISCORD_BOT_TOKEN: "discord",
          SLACK_BOT_TOKEN: "",
          SLACK_APP_TOKEN: "",
          SYSTEM_PROMPT_PATH: "",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      path: "",
      prompt: "",
    });
  });
});
