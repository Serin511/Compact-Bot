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

import { createInterface } from "node:readline/promises";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CONFIG_HOME } from "./paths.js";

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(question: string, fallback = ""): Promise<string> {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function askSecret(question: string): Promise<string> {
  const answer = (await rl.question(`  ${question}: `)).trim();
  return answer;
}

/**
 * Run the interactive init flow.
 *
 * Prompts for platform tokens, optional settings, and custom file paths.
 * Copies custom files (messages.json, system-prompt.txt) into CONFIG_HOME
 * and writes the generated .env file.
 */
export async function runInit(): Promise<void> {
  const envPath = join(CONFIG_HOME, ".env");

  console.log();
  console.log("  \x1b[1m@serin511/compact-bot\x1b[0m — 초기 설정");
  console.log(`  설정 경로: ${CONFIG_HOME}`);
  console.log();

  if (existsSync(envPath)) {
    const overwrite = await ask(".env 파일이 이미 존재합니다. 덮어쓸까요? (y/N)", "N");
    if (overwrite.toLowerCase() !== "y") {
      console.log("  취소되었습니다.");
      rl.close();
      return;
    }
    console.log();
  }

  // ── Platform tokens ────────────────────────────────────────────────

  console.log("  \x1b[36m[플랫폼 토큰]\x1b[0m Discord / Slack 중 최소 하나는 필수");
  console.log();

  const discordToken = await askSecret("Discord Bot Token (없으면 Enter)");
  const slackBotToken = await askSecret("Slack Bot Token - xoxb-... (없으면 Enter)");
  let slackAppToken = "";
  if (slackBotToken) {
    slackAppToken = await askSecret("Slack App Token - xapp-...");
  }

  if (!discordToken && !slackBotToken) {
    console.log();
    console.log("  \x1b[31m최소 하나의 플랫폼 토큰이 필요합니다.\x1b[0m");
    rl.close();
    process.exit(1);
  }

  console.log();

  // ── Optional settings ──────────────────────────────────────────────

  console.log("  \x1b[36m[선택 설정]\x1b[0m Enter를 누르면 기본값이 사용됩니다.");
  console.log();

  const model = await ask("기본 모델 (비우면 CLI 기본값)", "");
  const cwd = await ask("작업 디렉토리 (비우면 현재 폴더)", "");
  const maxTurns = await ask("최대 턴 수 (0=무제한)", "50");
  const skipPerms = await ask("--dangerously-skip-permissions 사용? (y/N)", "N");

  console.log();
  console.log("  \x1b[36m[커스텀 파일]\x1b[0m 경로를 입력하면 설정 폴더로 복사합니다.");
  console.log();

  const messagesPath = await ask("messages.json 경로 (없으면 Enter)", "");
  const systemPromptPath = await ask("system-prompt.txt 경로 (없으면 Enter)", "");

  let allowedChannelIds = "";
  if (discordToken) {
    allowedChannelIds = await ask("허용 Discord 채널 ID (쉼표 구분, 비우면 전체)", "");
  }

  let slackAllowedChannelIds = "";
  if (slackBotToken) {
    slackAllowedChannelIds = await ask("허용 Slack 채널 ID (쉼표 구분, 비우면 전체)", "");
  }

  rl.close();

  // ── Copy custom files ───────────────────────────────────────────────

  if (!existsSync(CONFIG_HOME)) mkdirSync(CONFIG_HOME, { recursive: true });

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
    copyFileSync(src, dest);
    console.log(`  \x1b[32m✔\x1b[0m ${basename(src)} → ${dest}`);
  }

  // ── Write .env ─────────────────────────────────────────────────────

  const lines: string[] = [
    "# [플랫폼 토큰] Discord / Slack 중 최소 하나는 필수",
  ];

  if (discordToken) {
    lines.push(`DISCORD_BOT_TOKEN=${discordToken}`);
  } else {
    lines.push("# DISCORD_BOT_TOKEN=");
  }

  if (slackBotToken) {
    lines.push(`SLACK_BOT_TOKEN=${slackBotToken}`);
    lines.push(`SLACK_APP_TOKEN=${slackAppToken}`);
  } else {
    lines.push("# SLACK_BOT_TOKEN=xoxb-...");
    lines.push("# SLACK_APP_TOKEN=xapp-...");
  }

  lines.push("");
  lines.push("# Defaults");
  if (model) {
    lines.push(`DEFAULT_MODEL=${model}`);
  } else {
    lines.push("# DEFAULT_MODEL=");
  }
  if (cwd) {
    lines.push(`DEFAULT_CWD=${cwd}`);
  } else {
    lines.push("# DEFAULT_CWD=");
  }
  lines.push(`MAX_TURNS=${maxTurns}`);
  if (skipPerms.toLowerCase() === "y") {
    lines.push("DANGEROUSLY_SKIP_PERMISSIONS=true");
  } else {
    lines.push("# DANGEROUSLY_SKIP_PERMISSIONS=false");
  }

  if (allowedChannelIds) {
    lines.push(`ALLOWED_CHANNEL_IDS=${allowedChannelIds}`);
  } else {
    lines.push("ALLOWED_CHANNEL_IDS=");
  }

  if (slackAllowedChannelIds) {
    lines.push(`SLACK_ALLOWED_CHANNEL_IDS=${slackAllowedChannelIds}`);
  } else {
    lines.push("SLACK_ALLOWED_CHANNEL_IDS=");
  }

  lines.push("");
  lines.push("VERBOSE=false");
  lines.push("");

  writeFileSync(envPath, lines.join("\n"));

  console.log();
  console.log(`  \x1b[32m✅ ${envPath} 생성 완료\x1b[0m`);
  console.log();
  console.log("  실행: \x1b[1mnpx @serin511/compact-bot\x1b[0m");
  console.log();
}
