/**
 * Customisable bot messages with sensible defaults.
 *
 * Loads optional overrides from a JSON file (default: data/messages.json).
 * Any key not present in the file falls back to its built-in default.
 * Supports template variables in the form {key} which are replaced at runtime.
 *
 * Exports:
 *   msg — look up a message by key, with optional template variable substitution.
 *
 * Example:
 *   >>> import { msg } from "./messages.js";
 *   >>> console.log(msg("processing")); // "⏳ 처리 중..."
 *   >>> console.log(msg("modelCurrent", { model: "opus" })); // "현재 모델: `opus`"
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_HOME } from "./paths.js";

const DEFAULTS: Record<string, string> = {
  processing: "⏳ 처리 중...",
  sessionCleared: "✅ 세션 초기화 완료. 다음 메시지부터 새 세션이 시작됩니다.",

  // Command responses
  newSession: "✅ 새 세션을 시작합니다. 재시작 중...",
  clearSession: "✅ 세션 초기화 완료.",
  compacting: "🔄 컨텍스트 압축 중...",
  modelCurrent: "현재 모델: `{model}`",
  modelChanged: "✅ 모델 변경: `{model}`. 재시작 중...",
  cwdCurrent: "현재 작업 디렉토리: `{cwd}`",
  cwdChanged: "✅ 작업 디렉토리 변경: `{path}`. 재시작 중...",
  help: [
    "📖 사용 가능한 명령어",
    "",
    "`/new` — 새 세션 시작",
    "`/clear` — 세션 초기화",
    "`/compact [힌트]` — 컨텍스트 압축",
    "`/model <name>` — 모델 변경 (sonnet, opus, haiku)",
    "`/cwd <path>` — 작업 디렉토리 변경",
    "`/capture` — CLI 화면 캡처",
    "`/help` — 이 도움말",
    "",
    "그 외 메시지는 Claude에게 전달됩니다.",
  ].join("\n"),

  // Capture
  captureRequested: "📸 CLI 화면 캡처 중...",
  captureEmpty: "⚠️ 캡처할 화면이 없습니다.",

  // Attachment messages
  attachmentTooLarge:
    "[첨부파일 \"{name}\" 은 {size}MB로 크기 제한(10MB)을 초과하여 건너뜀]",
  attachmentFailed: "[첨부파일 \"{name}\" 다운로드 실패]",
  attachmentNoUrl: "[첨부파일 \"{name}\" 다운로드 URL 없음]",
  attachmentImage: "[첨부 이미지: {path}]",
  attachmentFile: "[첨부 파일: {path}]",

  // Permission prompts
  permissionPrompt: "🔐 **권한 요청**: `{tool}`\n{action}",
  permissionAllowed: "✅ 허용됨",
  permissionDenied: "❌ 거부됨",
  permissionTimeout: "⏰ 시간 초과 (자동 거부)",
};

function loadCustomMessages(): Record<string, string> {
  // Check CONFIG_HOME first, then CWD for backwards compatibility
  for (const candidate of [
    join(CONFIG_HOME, "messages.json"),
    join(process.cwd(), "data", "messages.json"),
  ]) {
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf-8"));
      } catch {
        continue;
      }
    }
  }
  return {};
}

const custom = loadCustomMessages();

/**
 * Look up a bot message by key, returning the custom override or default.
 *
 * Supports template variables: use {key} placeholders in message strings,
 * then pass a vars object to substitute them at runtime.
 *
 * Args:
 *   key: Message key (e.g. "processing", "modelChanged").
 *   vars: Optional template variables to substitute (e.g. { model: "opus" }).
 *
 * Returns:
 *   The message string with variables substituted.
 */
export function msg(key: string, vars?: Record<string, string>): string {
  let text = custom[key] ?? DEFAULTS[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, v);
    }
  }
  return text;
}
