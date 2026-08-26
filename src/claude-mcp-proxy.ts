#!/usr/bin/env node

/**
 * Secretless local-MCP proxy for Claude Code and Codex.
 *
 * The wrapper consumes the small platform handshake. After that this process
 * forwards MCP stdio bytes verbatim and has no access to platform credentials,
 * wrapper IPC, or wrapper control commands.
 */

import { pathToFileURL } from "node:url";
import {
  connectClaudeMcpRelay,
  type ClaudeMcpPlatform,
} from "./claude-mcp-relay.js";

function parsePlatform(value: string | undefined): ClaudeMcpPlatform {
  if (value === "discord" || value === "slack") return value;
  throw new Error("MCP proxy requires discord or slack");
}

function isMainModule(): boolean {
  return Boolean(
    process.argv[1] &&
      pathToFileURL(process.argv[1]).href === import.meta.url,
  );
}

export async function runClaudeMcpProxy(
  platform: ClaudeMcpPlatform,
  relaySocketPath: string,
): Promise<void> {
  const relay = await connectClaudeMcpRelay(relaySocketPath, platform);
  process.stdin.pipe(relay);
  relay.pipe(process.stdout);

  const close = (): void => {
    relay.destroy();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);

  await new Promise<void>((resolve, reject) => {
    relay.once("close", resolve);
    relay.once("error", reject);
  });
}

if (isMainModule()) {
  const platform = parsePlatform(process.argv[2]);
  const relaySocketPath = process.argv[3];
  if (!relaySocketPath) {
    throw new Error("MCP proxy requires a relay socket path");
  }
  runClaudeMcpProxy(platform, relaySocketPath).catch((error) => {
    process.stderr.write(
      `[compact-bot MCP proxy] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  });
}
