/**
 * Bot configuration loaded from environment variables.
 *
 * Exports:
 *   config — frozen configuration object with all bot settings.
 *
 * Example:
 *   >>> import { config } from "./config.js";
 *   >>> console.log(config.defaultModel);
 */

import dotenv from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_HOME } from "./paths.js";

// CWD .env first (higher priority), then global .env (fills missing vars)
dotenv.config();
dotenv.config({ path: join(CONFIG_HOME, ".env") });

export interface Config {
  verbose: boolean;
  discordBotToken: string;
  claudePath: string;
  defaultModel: string;
  defaultCwd: string;
  maxTurns: number;
  fetchMessageLimit: number;
  allowedChannelIds: string[];

  slackBotToken: string;
  slackAppToken: string;
  slackAllowedChannelIds: string[];

  systemPromptPath: string;
}

/**
 * @deprecated Use `log.*` methods from `./logger.js` instead.
 * Kept temporarily for any transient imports.
 */
export function debugLog(...args: unknown[]): void {
  if (config.verbose) {
    console.log("[DEBUG]", ...args);
  }
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

const _config: Config = {
  verbose: optionalEnv("VERBOSE", "false") === "true",
  discordBotToken: optionalEnv("DISCORD_BOT_TOKEN", ""),
  claudePath: expandTilde(optionalEnv("CLAUDE_PATH", "~/.local/bin/claude")),
  defaultModel: optionalEnv("DEFAULT_MODEL", "claude-sonnet-4-6"),
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

export const COMPACT_PROMPT = `You have been working on the task described above but have not yet \
completed it. Write a continuation summary that will allow you (or \
another instance of yourself) to resume work efficiently in a future \
context window where the conversation history will be replaced with \
this summary. Your summary should be structured, concise, and \
actionable. Include:

1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified

2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced

3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)

4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain

5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user

Be concise but complete—err on the side of including information that \
would prevent duplicate work or repeated mistakes. Write in a way that \
enables immediate resumption of the task.

Wrap your summary in <summary></summary> tags.`;

export const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Bash",
  "Write",
  "Edit",
];
