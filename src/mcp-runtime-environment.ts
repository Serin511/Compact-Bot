/**
 * Process-local configuration for a platform MCP server.
 *
 * Claude Code and Codex launch only a secretless stdio proxy. The wrapper
 * starts the real platform MCP child for either provider, writes sensitive
 * values to that child's inherited fd 3, and this module loads them before the
 * server initializes.
 *
 * Keeping the override in JavaScript memory avoids copying Discord, Slack, or
 * wrapper-control credentials into either agent host's model-readable
 * environment, MCP config, command line, or the MCP process environment.
 */

import {
  closeSync,
  readFileSync,
} from "node:fs";

export const MCP_RUNTIME_FD_ENV = "COMPACT_BOT_MCP_RUNTIME_FD";
const MAX_RUNTIME_PAYLOAD_BYTES = 64 * 1024;

let runtimeEnvironment: Readonly<Record<string, string>> | null = null;
let runtimeFdChecked = false;

function parseRuntimeEnvironment(text: string): Record<string, string> {
  if (Buffer.byteLength(text) > MAX_RUNTIME_PAYLOAD_BYTES) {
    throw new Error("MCP runtime payload exceeded the size limit");
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP runtime payload must be an object");
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new Error(`MCP runtime setting ${key} must be a string`);
    }
    result[key] = item;
  }
  return result;
}

function loadInheritedRuntimeEnvironment(): void {
  if (runtimeFdChecked || runtimeEnvironment) return;
  runtimeFdChecked = true;
  const rawFd = process.env[MCP_RUNTIME_FD_ENV];
  if (!rawFd) return;
  delete process.env[MCP_RUNTIME_FD_ENV];
  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1024) {
    throw new Error("Invalid MCP runtime file descriptor");
  }
  let payload: string;
  try {
    payload = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  runtimeEnvironment = Object.freeze(
    parseRuntimeEnvironment(payload.trim()),
  );
}

/** Install one immutable runtime environment before loading an MCP module. */
export function installMcpRuntimeEnvironment(
  values: Readonly<Record<string, string>>,
): void {
  if (runtimeEnvironment) {
    throw new Error("MCP runtime environment is already installed");
  }
  runtimeEnvironment = Object.freeze({ ...values });
}

/**
 * Read an MCP setting.
 *
 * The process environment fallback preserves the direct Codex launch path and
 * backwards compatibility for users invoking the server module themselves.
 */
export function mcpRuntimeValue(name: string): string | undefined {
  loadInheritedRuntimeEnvironment();
  return runtimeEnvironment
    ? runtimeEnvironment[name]
    : process.env[name];
}

/** Read a required MCP setting with a useful startup failure. */
export function requireMcpRuntimeValue(name: string): string {
  const value = mcpRuntimeValue(name);
  if (!value) throw new Error(`Missing required MCP runtime setting: ${name}`);
  return value;
}

/**
 * Test-only lifecycle helper.
 *
 * Each production launcher installs exactly once and then remains the MCP
 * process, while Vitest exercises more than one isolated bootstrap scenario
 * in a shared worker.
 */
export function resetMcpRuntimeEnvironmentForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("MCP runtime environment can only be reset in tests");
  }
  runtimeEnvironment = null;
  runtimeFdChecked = false;
}
