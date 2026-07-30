import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMessages(provider: "claude" | "codex") {
  vi.resetModules();
  vi.stubEnv("AGENT_PROVIDER", provider);
  vi.stubEnv(
    "XDG_CONFIG_HOME",
    `/tmp/compact-bot-messages-test-${process.pid}`,
  );
  return import("../src/messages.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("provider-specific command help", () => {
  it("describes Codex capture as a transcript instead of a CLI viewport", async () => {
    const { msg } = await loadMessages("codex");

    expect(msg("help")).toContain("Codex 대화·실행 기록 캡처");
    expect(msg("help")).toContain("기본: 최근 50줄");
    expect(msg("help")).toContain("`--all`: 현재 스레드 전체 기록");
    expect(msg("help")).not.toContain("CLI 화면 캡처");
    expect(msg("captureRequested")).toBe(
      "📸 Codex 대화·실행 기록 캡처 중...",
    );
    expect(msg("captureEmpty")).toBe("⚠️ 캡처할 Codex 기록이 없습니다.");
  });

  it("describes Codex interrupt and raw turn semantics precisely", async () => {
    const { msg } = await loadMessages("codex");

    expect(msg("help")).toContain("`/esc` — 진행 중인 Codex 턴 중단");
    expect(msg("help")).not.toContain("ESC 키 전송");
    expect(msg("help")).toContain(
      "`/raw <text>` — 텍스트를 Codex 턴 입력으로 전송 (진행 중이면 steer, CLI 명령이 아님)",
    );
    expect(msg("escSent")).toBe("⏹️ 진행 중인 Codex 턴 중단 요청됨.");
  });

  it("preserves Claude Code PTY command descriptions", async () => {
    const { msg } = await loadMessages("claude");

    expect(msg("help")).toContain("CLI 화면 캡처");
    expect(msg("help")).toContain("ESC 키 전송");
    expect(msg("help")).toContain("CLI에 텍스트를 그대로 입력");
    expect(msg("captureRequested")).toBe("📸 CLI 화면 캡처 중...");
    expect(msg("captureEmpty")).toBe("⚠️ 캡처할 화면이 없습니다.");
    expect(msg("escSent")).toBe("⎋ ESC 전송됨.");
  });
});
