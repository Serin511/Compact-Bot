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

const AGENT_NAME =
  process.env.AGENT_PROVIDER === "codex" ? "Codex" : "Claude Code";
const COMPACT_HELP =
  process.env.AGENT_PROVIDER === "codex"
    ? "`/compact` — 컨텍스트 압축"
    : "`/compact [힌트]` — 컨텍스트 압축 (선택적 힌트로 중점 영역 지정)";
const MODEL_HELP =
  process.env.AGENT_PROVIDER === "codex"
    ? "`/model [name]` — Codex 모델 조회/변경 (전체 모델 ID)"
    : "`/model [name]` — 모델 조회/변경 (sonnet, opus, haiku 또는 전체 ID)";
const EFFORT_HELP =
  process.env.AGENT_PROVIDER === "codex"
    ? "`/effort [level]` — reasoning effort 조회/변경"
    : "`/effort` — Codex 모드에서만 사용 가능";
const RAW_HELP =
  process.env.AGENT_PROVIDER === "codex"
    ? "`/raw <text>` — 텍스트를 새 Codex 입력으로 전송"
    : "`/raw <text>` — CLI에 텍스트를 그대로 입력 (예: `/raw /agents`, `/raw /config`)";

const DEFAULTS: Record<string, string> = {
  processing: "⏳ 처리 중...",
  sessionCleared: "✅ 세션 초기화 완료. 다음 메시지부터 새 세션이 시작됩니다.",

  // Command responses
  newSession: `✅ 새 ${AGENT_NAME} 세션을 시작합니다...`,
  clearSession: "✅ 세션 초기화 완료.",
  compacting: "🔄 컨텍스트 압축 중...",
  modelCurrent: "현재 모델: `{model}`",
  modelChanged: "✅ 모델 변경: `{model}`. 재시작 중...",
  effortCurrent: "현재 reasoning effort: `{effort}`",
  effortChanged:
    "✅ reasoning effort 변경: `{effort}`. 다음 새 턴부터 적용됩니다.",
  effortUnsupported: "⚠️ `/effort`는 Codex 모드에서만 사용할 수 있습니다.",
  effortInvalid: "⚠️ 지원하는 effort 값: `{efforts}`",
  effortUnavailable:
    "⚠️ `{model}`은 `{effort}`를 지원하지 않습니다. 사용 가능: `{efforts}`",
  effortChangeFailed: "⚠️ reasoning effort 변경 실패: {reason}",
  cwdCurrent: "현재 작업 디렉토리: `{cwd}`",
  cwdChanged: "✅ 작업 디렉토리 변경: `{path}`. 재시작 중...",
  help: [
    "📖 사용 가능한 명령어",
    "",
    "━━ 세션 관리 ━━",
    `\`/new\` — 새 ${AGENT_NAME} 세션 시작`,
    "`/clear` — 세션 초기화",
    COMPACT_HELP,
    "",
    "━━ 설정 변경 ━━",
    MODEL_HELP,
    EFFORT_HELP,
    "`/cwd [path]` — 작업 디렉토리 조회/변경",
    "",
    "━━ CLI 제어 ━━",
    "`/capture [--all]` — CLI 화면 캡처 (기본: 현재 화면, `--all`: 전체 스크롤백)",
    "`/esc` — ESC 키 전송 (진행 중인 작업 중단 · 멈춘 세션 복구용 안전망)",
    RAW_HELP,
    "`/goal <조건>` — 조건이 충족될 때까지 자동으로 턴 반복 (종료: `/goal clear`)",
    "",
    "━━ 도움말 ━━",
    "`/help` — 이 도움말",
    "",
    `그 외 메시지는 ${AGENT_NAME}에 전달됩니다.`,
  ].join("\n"),

  // Passthrough commands
  escSent: "⎋ ESC 전송됨.",
  rawSent: `⌨️ ${AGENT_NAME}에 입력 전송됨: \`{text}\``,
  rawMissing: "⚠️ 사용법: `/raw <텍스트>`",
  goalSet: "🎯 목표 설정: `{goal}`",
  goalCleared: "🎯 목표 모드 종료.",
  goalMissing: "⚠️ 사용법: `/goal <조건>` (종료: `/goal clear`)",

  // Capture
  captureRequested:
    process.env.AGENT_PROVIDER === "codex"
      ? "📸 Codex 상태 확인 중..."
      : "📸 CLI 화면 캡처 중...",
  captureEmpty: "⚠️ 캡처할 화면이 없습니다.",
  captureNoResponse: `⚠️ wrapper가 캡처 요청에 응답하지 않았습니다. ${AGENT_NAME}가 멈췄거나 재시작 중일 수 있습니다.`,

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

  // User input prompts (AskUserQuestion relay)
  inputRequest: `❓ **${AGENT_NAME}의 질문**\n\n{question}\n\n💬 다음 메시지로 답변해주세요.`,
  inputResponseSent: "✅ 답변이 전달되었습니다.",
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
