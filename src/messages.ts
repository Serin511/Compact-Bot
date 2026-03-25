/**
 * Customisable bot messages with sensible defaults.
 *
 * Loads optional overrides from a JSON file (default: data/messages.json).
 * Any key not present in the file falls back to its built-in default.
 *
 * Exports:
 *   msg — look up a message by key.
 *
 * Example:
 *   >>> import { msg } from "./messages.js";
 *   >>> console.log(msg("processing")); // "⏳ 처리 중..."
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULTS: Record<string, string> = {
  processing: "⏳ 처리 중...",
  sessionCleared: "✅ 세션 초기화 완료. 다음 메시지부터 새 세션이 시작됩니다.",
};

function loadCustomMessages(): Record<string, string> {
  const filePath = resolve("data/messages.json");
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

const custom = loadCustomMessages();

/**
 * Look up a bot message by key, returning the custom override or default.
 *
 * Args:
 *   key: Message key (e.g. "processing", "sessionCleared").
 *
 * Returns:
 *   The message string.
 */
export function msg(key: keyof typeof DEFAULTS): string {
  return custom[key] ?? DEFAULTS[key] ?? key;
}
