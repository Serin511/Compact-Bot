/**
 * Interactive init command that generates a .env file.
 *
 * Prompts the user for platform tokens, optional settings, and
 * custom file paths (messages.json, system-prompt.txt). Copies
 * custom files into ~/.config/compact-bot/ and writes a .env file.
 *
 * Exports:
 *   runInit — execute the interactive setup flow.
 */

import { createInterface, type Interface } from "node:readline/promises";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { CONFIG_HOME } from "./paths.js";
import {
  KNOWN_REASONING_EFFORTS,
  normalizeReasoningEffort,
} from "./reasoning-effort.js";
import { parseMaxTurns } from "./turn-limit.js";

class MutablePromptOutput extends Writable {
  muted = false;

  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }

  get columns(): number | undefined {
    return (this.target as NodeJS.WriteStream).columns;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.target.write(chunk);
    callback();
  }
}

/**
 * Shared interactive prompt session. Secret answers are never written to the
 * configured output stream, including when readline is operating in TTY mode.
 */
export class PromptSession {
  private readonly promptOutput: MutablePromptOutput;
  private readonly rl: Interface;
  private readonly closed: Promise<void>;

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
    terminal = Boolean(
      (input as NodeJS.ReadStream).isTTY &&
        (output as NodeJS.WriteStream).isTTY,
    ),
  ) {
    this.promptOutput = new MutablePromptOutput(output);
    this.rl = createInterface({
      input,
      output: this.promptOutput,
      terminal,
    });
    this.closed = new Promise((resolveClosed) => {
      this.rl.once("close", resolveClosed);
    });
  }

  private async question(prompt: string): Promise<string> {
    const result = await Promise.race([
      this.rl.question(prompt).then((answer) => ({ answer })),
      this.closed.then(() => null),
    ]);
    if (!result) {
      throw new PromptInputClosedError();
    }
    return result.answer;
  }

  async ask(question: string, fallback = ""): Promise<string> {
    const suffix = fallback ? ` (${fallback})` : "";
    const answer = (await this.question(`  ${question}${suffix}: `)).trim();
    return answer || fallback;
  }

  async askSecret(question: string): Promise<string> {
    this.output.write(`  ${question}: `);
    this.promptOutput.muted = true;
    try {
      return (await this.question("")).trim();
    } finally {
      this.promptOutput.muted = false;
      this.output.write("\n");
    }
  }

  close(): void {
    this.rl.close();
  }
}

export class PromptInputClosedError extends Error {
  constructor() {
    super("Interactive input was closed.");
    this.name = "PromptInputClosedError";
  }
}

/** Create CONFIG_HOME with owner-only permissions, repairing older installs. */
export function ensureSecureConfigHome(configHome = CONFIG_HOME): void {
  mkdirSync(configHome, { recursive: true, mode: 0o700 });
  chmodSync(configHome, 0o700);
}

/** Write the generated environment file with owner-only permissions. */
export function writeSecureEnvFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o600 });
  // writeFileSync preserves the mode of an existing file, so repair it too.
  chmodSync(path, 0o600);
}

/**
 * Serialize one dotenv value without letting `#`, whitespace, or backslashes
 * change its meaning when the generated file is loaded again.
 *
 * dotenv preserves single- and backtick-quoted values literally. Double quotes
 * are a final fallback only when their `\n` / `\r` escape rules cannot alter
 * the input. Interactive answers cannot contain physical newlines.
 */
export function serializeEnvValue(value: string): string {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("Environment values must be a single line.");
  }
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (
    !value.includes('"') &&
    !value.includes("\\n") &&
    !value.includes("\\r")
  ) {
    return `"${value}"`;
  }
  if (!value.includes("#") && value.trim() === value) return value;
  throw new Error(
    "Environment value contains a combination of characters that cannot be represented safely.",
  );
}

/**
 * Run the interactive init flow.
 *
 * Prompts for platform tokens, optional settings, and custom file paths.
 * Copies custom files (messages.json, system-prompt.txt) into CONFIG_HOME
 * and writes the generated .env file.
 */
export async function runInit(): Promise<void> {
  const prompts = new PromptSession();
  const envPath = join(CONFIG_HOME, ".env");

  try {
    ensureSecureConfigHome();
    if (existsSync(envPath)) chmodSync(envPath, 0o600);

    console.log();
    console.log("  \x1b[1m@serin511/compact-bot\x1b[0m — 초기 설정");
    console.log(`  설정 경로: ${CONFIG_HOME}`);
    console.log();

    if (existsSync(envPath)) {
      const overwrite = await prompts.ask(
        ".env 파일이 이미 존재합니다. 덮어쓸까요? (y/N)",
        "N",
      );
      if (overwrite.toLowerCase() !== "y") {
        console.log("  취소되었습니다.");
        return;
      }
      console.log();
    }

    // ── Agent backend ────────────────────────────────────────────────

    console.log("  \x1b[36m[에이전트]\x1b[0m Claude Code 또는 Codex를 선택하세요.");
    console.log();

    const providerInput = (
      await prompts.ask("에이전트 (claude/codex)", "claude")
    ).toLowerCase();
    if (providerInput !== "claude" && providerInput !== "codex") {
      console.log();
      console.log("  \x1b[31m에이전트는 claude 또는 codex여야 합니다.\x1b[0m");
      process.exitCode = 1;
      return;
    }
    const provider: "claude" | "codex" = providerInput;
    const cliPath = await prompts.ask(
      `${provider === "codex" ? "Codex" : "Claude Code"} CLI 경로`,
      provider === "codex" ? "codex" : "claude",
    );
    console.log();

    // ── Platform tokens ──────────────────────────────────────────────

    console.log("  \x1b[36m[플랫폼 토큰]\x1b[0m Discord / Slack 중 최소 하나는 필수");
    console.log();

    const discordToken = await prompts.askSecret(
      "Discord Bot Token (없으면 Enter)",
    );
    const slackBotToken = await prompts.askSecret(
      "Slack Bot Token - xoxb-... (없으면 Enter)",
    );
    let slackAppToken = "";
    if (slackBotToken) {
      slackAppToken = await prompts.askSecret("Slack App Token - xapp-...");
      if (!slackAppToken) {
        console.log();
        console.log(
          "  \x1b[31mSlack을 사용하려면 Bot Token과 App Token이 모두 필요합니다.\x1b[0m",
        );
        process.exitCode = 1;
        return;
      }
    }

    if (!discordToken && !slackBotToken) {
      console.log();
      console.log("  \x1b[31m최소 하나의 플랫폼 토큰이 필요합니다.\x1b[0m");
      process.exitCode = 1;
      return;
    }

    console.log();

    // ── Optional settings ────────────────────────────────────────────

    console.log("  \x1b[36m[선택 설정]\x1b[0m Enter를 누르면 기본값이 사용됩니다.");
    console.log();

    const model = await prompts.ask("기본 모델 (비우면 CLI 기본값)", "");
    const reasoningEffort = provider === "codex"
      ? (
          await prompts.ask(
            "기본 reasoning effort (비우면 Codex 설정값)",
            "",
          )
        ).toLowerCase()
      : "";
    if (reasoningEffort && !normalizeReasoningEffort(reasoningEffort)) {
      console.log();
      console.log(
        `  \x1b[31mreasoning effort는 ${KNOWN_REASONING_EFFORTS.join(", ")} 중 하나여야 합니다.\x1b[0m`,
      );
      process.exitCode = 1;
      return;
    }
    const cwd = await prompts.ask("작업 디렉토리 (비우면 현재 폴더)", "");
    const maxTurns = provider === "claude"
      ? await prompts.ask("최대 턴 수 (0=무제한)", "50")
      : "0";
    if (parseMaxTurns(maxTurns) === null) {
      console.log();
      console.log(
        "  \x1b[31m최대 턴 수는 0 또는 양의 정수여야 합니다.\x1b[0m",
      );
      process.exitCode = 1;
      return;
    }
    const skipPerms = await prompts.ask(
      provider === "codex"
        ? "승인 없이 전체 파일·네트워크 접근을 허용? (y/N)"
        : "--dangerously-skip-permissions 사용? (y/N)",
      "N",
    );

    console.log();
    console.log("  \x1b[36m[커스텀 파일]\x1b[0m 경로를 입력하면 설정 폴더로 복사합니다.");
    console.log();

    const messagesPath = await prompts.ask(
      "messages.json 경로 (없으면 Enter)",
      "",
    );
    const systemPromptPath = await prompts.ask(
      "system-prompt.txt 경로 (없으면 Enter)",
      "",
    );

    let allowedChannelIds = "";
    let discordOperatorUserIds = "";
    if (discordToken) {
      allowedChannelIds = await prompts.ask(
        "허용 Discord 채널 ID (쉼표 구분, 비우면 전체)",
        "",
      );
      discordOperatorUserIds = await prompts.ask(
        "Discord operator 사용자 ID (쉼표 구분, 비우면 허용 채널 전체)",
        "",
      );
    }

    let slackAllowedChannelIds = "";
    let slackOperatorUserIds = "";
    if (slackBotToken) {
      slackAllowedChannelIds = await prompts.ask(
        "허용 Slack 채널 ID (쉼표 구분, 비우면 전체)",
        "",
      );
      slackOperatorUserIds = await prompts.ask(
        "Slack operator 사용자 ID (쉼표 구분, 비우면 허용 채널 전체)",
        "",
      );
    }

    // ── Copy custom files ─────────────────────────────────────────────

    let configuredSystemPromptPath = "";
    for (const [inputPath, destName] of [
      [messagesPath, "messages.json"],
      [systemPromptPath, "system-prompt.txt"],
    ] as const) {
      if (!inputPath) continue;
      const src = resolve(inputPath.replace(/^~/, process.env.HOME ?? ""));
      if (!existsSync(src)) {
        console.log(`  \x1b[33m⚠ 파일을 찾을 수 없습니다: ${src}\x1b[0m`);
        continue;
      }
      const dest = join(CONFIG_HOME, destName);
      if (src !== resolve(dest)) copyFileSync(src, dest);
      chmodSync(dest, 0o600);
      if (destName === "system-prompt.txt") {
        configuredSystemPromptPath = dest;
      }
      console.log(`  \x1b[32m✔\x1b[0m ${basename(src)} → ${dest}`);
    }

    // ── Write .env ───────────────────────────────────────────────────

    const lines: string[] = [
      "# Agent backend: claude or codex",
      `AGENT_PROVIDER=${provider}`,
      provider === "codex"
        ? `CODEX_PATH=${serializeEnvValue(cliPath)}`
        : `CLAUDE_PATH=${serializeEnvValue(cliPath)}`,
      "",
      "# [플랫폼 토큰] Discord / Slack 중 최소 하나는 필수",
    ];

    if (discordToken) {
      lines.push(`DISCORD_BOT_TOKEN=${serializeEnvValue(discordToken)}`);
    } else {
      lines.push("DISCORD_BOT_TOKEN=");
    }

    if (slackBotToken) {
      lines.push(`SLACK_BOT_TOKEN=${serializeEnvValue(slackBotToken)}`);
      lines.push(`SLACK_APP_TOKEN=${serializeEnvValue(slackAppToken)}`);
    } else {
      lines.push("SLACK_BOT_TOKEN=");
      lines.push("SLACK_APP_TOKEN=");
    }

    lines.push("");
    lines.push("# Defaults");
    if (model) {
      lines.push(`DEFAULT_MODEL=${serializeEnvValue(model)}`);
    } else {
      lines.push("# DEFAULT_MODEL=");
    }
    if (provider === "codex" && reasoningEffort) {
      lines.push(
        `DEFAULT_REASONING_EFFORT=${serializeEnvValue(reasoningEffort)}`,
      );
    } else if (provider === "codex") {
      lines.push("# DEFAULT_REASONING_EFFORT=");
    } else {
      lines.push("# DEFAULT_REASONING_EFFORT is only used by Codex");
    }
    if (cwd) {
      lines.push(`DEFAULT_CWD=${serializeEnvValue(cwd)}`);
    } else {
      lines.push("# DEFAULT_CWD=");
    }
    if (provider === "claude") {
      lines.push(`MAX_TURNS=${serializeEnvValue(maxTurns)}`);
    } else {
      lines.push("# MAX_TURNS is only used by Claude Code");
    }
    // Preserve an explicit blank. Without this line config loading falls back
    // to an old CONFIG_HOME/system-prompt.txt left by an earlier setup run.
    lines.push(
      `SYSTEM_PROMPT_PATH=${serializeEnvValue(configuredSystemPromptPath)}`,
    );
    if (skipPerms.toLowerCase() === "y") {
      lines.push("DANGEROUSLY_SKIP_PERMISSIONS=true");
    } else {
      lines.push("# DANGEROUSLY_SKIP_PERMISSIONS=false");
    }

    lines.push(
      `ALLOWED_CHANNEL_IDS=${serializeEnvValue(allowedChannelIds)}`,
    );
    lines.push(
      `DISCORD_OPERATOR_USER_IDS=${serializeEnvValue(discordOperatorUserIds)}`,
    );
    lines.push(
      `SLACK_ALLOWED_CHANNEL_IDS=${serializeEnvValue(slackAllowedChannelIds)}`,
    );
    lines.push(
      `SLACK_OPERATOR_USER_IDS=${serializeEnvValue(slackOperatorUserIds)}`,
    );

    lines.push("");
    lines.push("VERBOSE=false");
    lines.push("");

    writeSecureEnvFile(envPath, lines.join("\n"));

    console.log();
    console.log(`  \x1b[32m✅ ${envPath} 생성 완료\x1b[0m`);
    console.log("  파일 권한: 현재 사용자만 읽기/쓰기 (0600)");
    console.log();
    console.log("  실행: \x1b[1mnpx @serin511/compact-bot\x1b[0m");
    console.log();
  } catch (error) {
    if (error instanceof PromptInputClosedError) {
      console.error("\n  입력이 종료되어 초기 설정을 취소했습니다.");
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    prompts.close();
  }
}
