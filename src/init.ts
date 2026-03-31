/**
 * Interactive init command that generates a .env file.
 *
 * Prompts the user for platform tokens and optional settings,
 * then writes a .env file to ~/.config/compact-bot/.
 *
 * Exports:
 *   runInit — execute the interactive setup flow.
 */

import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Run the interactive init flow and write .env to CONFIG_HOME.
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

  const model = await ask("기본 모델", "claude-sonnet-4-6");
  const cwd = await ask("작업 디렉토리", "~/");
  const maxTurns = await ask("최대 턴 수 (0=무제한)", "50");

  let allowedChannelIds = "";
  if (discordToken) {
    allowedChannelIds = await ask("허용 Discord 채널 ID (쉼표 구분, 비우면 전체)", "");
  }

  let slackAllowedChannelIds = "";
  if (slackBotToken) {
    slackAllowedChannelIds = await ask("허용 Slack 채널 ID (쉼표 구분, 비우면 전체)", "");
  }

  rl.close();

  // ── Write .env ─────────────────────────────────────────────────────

  if (!existsSync(CONFIG_HOME)) mkdirSync(CONFIG_HOME, { recursive: true });

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
  lines.push(`DEFAULT_MODEL=${model}`);
  lines.push(`DEFAULT_CWD=${cwd}`);
  lines.push(`MAX_TURNS=${maxTurns}`);

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
