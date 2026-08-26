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
import { normalizeFetchMessageLimit } from "./fetch-limit.js";
import { parseMaxTurns } from "./turn-limit.js";

// CWD .env first (higher priority), then global .env (fills missing vars).
// Keep the parsed local values so Codex mode can reject platform credentials
// stored in a model-readable workspace file.
const localEnvPath = resolve(process.cwd(), ".env");
const localEnvResult = dotenv.config({ path: localEnvPath, quiet: true });
dotenv.config({ path: join(CONFIG_HOME, ".env"), quiet: true });

const PLATFORM_CREDENTIAL_KEYS = [
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
] as const;

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
  discordOperatorUserIds: string[];

  slackBotToken: string;
  slackAppToken: string;
  slackAllowedChannelIds: string[];
  slackOperatorUserIds: string[];

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

function optionalEnvPreservingEmpty(key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(process.env, key)
    ? process.env[key] ?? ""
    : fallback;
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

const agentProvider = parseAgentProvider(
  optionalEnv("AGENT_PROVIDER", "claude"),
);
const localPlatformCredentialKeys = PLATFORM_CREDENTIAL_KEYS.filter(
  (key) => Boolean(localEnvResult.parsed?.[key]?.trim()),
);
if (agentProvider === "codex" && localPlatformCredentialKeys.length > 0) {
  throw new Error(
    `Codex mode refuses platform credentials from ${localEnvPath} because workspace files are readable by the agent. ` +
      `Run "compact-bot init" to store them under ${CONFIG_HOME}, then remove the token values from the local .env. ` +
      `Unsafe keys: ${localPlatformCredentialKeys.join(", ")}.`,
  );
}
const maxTurnsValue = optionalEnv("MAX_TURNS", "50");
const parsedMaxTurns = parseMaxTurns(maxTurnsValue);
if (agentProvider === "claude" && parsedMaxTurns === null) {
  throw new Error(
    `Invalid MAX_TURNS: ${maxTurnsValue}. Expected zero or a positive integer.`,
  );
}
const maxTurns = agentProvider === "claude" ? parsedMaxTurns! : 0;

const _config: Config = {
  agentProvider,
  verbose: optionalEnv("VERBOSE", "false") === "true",
  dangerouslySkipPermissions:
    optionalEnv("DANGEROUSLY_SKIP_PERMISSIONS", "false") === "true",
  discordBotToken: optionalEnv("DISCORD_BOT_TOKEN", ""),
  claudePath: expandTilde(optionalEnv("CLAUDE_PATH", "claude")),
  codexPath: expandTilde(optionalEnv("CODEX_PATH", "codex")),
  defaultModel: optionalEnv("DEFAULT_MODEL", ""),
  defaultReasoningEffort,
  defaultCwd: expandTilde(optionalEnv("DEFAULT_CWD", process.cwd())),
  maxTurns,
  fetchMessageLimit: normalizeFetchMessageLimit(
    optionalEnv("FETCH_MESSAGE_LIMIT", "20"),
  ),
  allowedChannelIds: optionalEnv("ALLOWED_CHANNEL_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  discordOperatorUserIds: optionalEnv("DISCORD_OPERATOR_USER_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  slackBotToken: optionalEnv("SLACK_BOT_TOKEN", ""),
  slackAppToken: optionalEnv("SLACK_APP_TOKEN", ""),
  slackAllowedChannelIds: optionalEnv("SLACK_ALLOWED_CHANNEL_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  slackOperatorUserIds: optionalEnv("SLACK_OPERATOR_USER_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  systemPromptPath: optionalEnvPreservingEmpty(
    "SYSTEM_PROMPT_PATH",
    existsSync(join(CONFIG_HOME, "system-prompt.txt"))
      ? join(CONFIG_HOME, "system-prompt.txt")
      : "data/system-prompt.txt",
  ),
};

if (Boolean(_config.slackBotToken) !== Boolean(_config.slackAppToken)) {
  throw new Error(
    "SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set together.",
  );
}

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
  if (!config.systemPromptPath) return "";
  const filePath = resolve(config.systemPromptPath);
  if (!existsSync(filePath)) return "";
  try {
    return readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

export const systemPrompt = loadSystemPrompt();
