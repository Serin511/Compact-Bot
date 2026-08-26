/**
 * Compact Bot application version used by runtime protocol clients.
 *
 * package.json is shipped beside dist/ in the npm artifact, so it can remain
 * the single source of truth for the CLI, Codex client, and both MCP servers.
 */
import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (
  typeof packageMetadata.version !== "string" ||
  packageMetadata.version.length === 0
) {
  throw new Error("Compact Bot package version is missing.");
}

export const COMPACT_BOT_VERSION = packageMetadata.version;

/** MCP implementation metadata exposed by the platform bridge servers. */
export const DISCORD_MCP_SERVER_INFO = {
  name: "discord-bot",
  version: COMPACT_BOT_VERSION,
} as const;

export const SLACK_MCP_SERVER_INFO = {
  name: "slack-bot",
  version: COMPACT_BOT_VERSION,
} as const;
