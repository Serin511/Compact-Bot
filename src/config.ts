/**
 * Bot configuration loaded from environment variables.
 *
 * Exports:
 *   config, Config, loadSystemPrompt, systemPrompt.
 *
 * Example:
 *   >>> import { config } from "./config.js";
 *   >>> console.log(config.agentProvider);
 */

import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_HOME } from "./paths.js";
import {
  KNOWN_REASONING_EFFORTS,
  normalizeReasoningEffort,
} from "./reasoning-effort.js";

// CWD .env first (higher priority), then global .env (fills missing vars)
dotenv.config();
dotenv.config({ path: join(CONFIG_HOME, ".env") });

export interface Config {
  agentProvider: "claude" | "codex";
  verbose: boolean;
  dangerouslySkipPermissions: boolean;
  discordBotToken: string;
  claudePath: string;
  codexPath: string;
  defaultModel: string;
  defaultReasoningEffort: string;
  defaultCwd: string;
  maxTurns: number;
  fetchMessageLimit: number;
  allowedChannelIds: string[];

  slackBotToken: string;
  slackAppToken: string;
  slackAllowedChannelIds: string[];

  systemPromptPath: string;
}


function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function expandTilde(path: string): string {
  if (path.startsWith("~")) {
    return path.replace("~", process.env.HOME ?? "");
  }
  return path;
}

function parseAgentProvider(value: string): "claude" | "codex" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex") return normalized;
  throw new Error(
    `Invalid AGENT_PROVIDER: ${value}. Expected "claude" or "codex".`,
  );
}

const defaultReasoningEffort = optionalEnv("DEFAULT_REASONING_EFFORT", "")
  .trim()
  .toLowerCase();
if (
  defaultReasoningEffort &&
  !normalizeReasoningEffort(defaultReasoningEffort)
) {
  throw new Error(
    `Invalid DEFAULT_REASONING_EFFORT: ${defaultReasoningEffort}. Expected one of: ${KNOWN_REASONING_EFFORTS.join(", ")}.`,
  );
}

const _config: Config = {
  agentProvider: parseAgentProvider(optionalEnv("AGENT_PROVIDER", "claude")),
  verbose: optionalEnv("VERBOSE", "false") === "true",
  dangerouslySkipPermissions:
    optionalEnv("DANGEROUSLY_SKIP_PERMISSIONS", "false") === "true",
  discordBotToken: optionalEnv("DISCORD_BOT_TOKEN", ""),
  claudePath: expandTilde(optionalEnv("CLAUDE_PATH", "claude")),
  codexPath: expandTilde(optionalEnv("CODEX_PATH", "codex")),
  defaultModel: optionalEnv("DEFAULT_MODEL", ""),
  defaultReasoningEffort,
  defaultCwd: expandTilde(optionalEnv("DEFAULT_CWD", process.cwd())),
  maxTurns: Number(optionalEnv("MAX_TURNS", "50")),
  fetchMessageLimit: Number(optionalEnv("FETCH_MESSAGE_LIMIT", "20")),
  allowedChannelIds: optionalEnv("ALLOWED_CHANNEL_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  slackBotToken: optionalEnv("SLACK_BOT_TOKEN", ""),
  slackAppToken: optionalEnv("SLACK_APP_TOKEN", ""),
  slackAllowedChannelIds: optionalEnv("SLACK_ALLOWED_CHANNEL_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  systemPromptPath: optionalEnv(
    "SYSTEM_PROMPT_PATH",
    existsSync(join(CONFIG_HOME, "system-prompt.txt"))
      ? join(CONFIG_HOME, "system-prompt.txt")
      : "data/system-prompt.txt",
  ),
};

if (!_config.discordBotToken && !_config.slackBotToken) {
  throw new Error(
    "At least one platform token is required: DISCORD_BOT_TOKEN or SLACK_BOT_TOKEN",
  );
}

export const config: Config = Object.freeze(_config);

/**
 * Load system prompt from the configured file path.
 *
 * Returns:
 *   The file contents as a string, or empty string if the file doesn't exist.
 */
export function loadSystemPrompt(): string {
  const filePath = resolve(config.systemPromptPath);
  if (!existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

export const systemPrompt = loadSystemPrompt();
