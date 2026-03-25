/**
 * Discord event handler — core message processing loop.
 *
 * Receives messageCreate events, routes them through the message router,
 * and dispatches to the appropriate handler (Claude CLI, compact, clear, etc.).
 * Also handles messageReactionAdd for cancel and retry interactions.
 *
 * Exports:
 *   handleMessage, handleReaction.
 *
 * Example:
 *   >>> client.on("messageCreate", (msg) => handleMessage(msg, sessionManager));
 *   >>> client.on("messageReactionAdd", (r, u) => handleReaction(r, u, sessionManager));
 */

import {
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { callClaude } from "./claude-cli.js";
import { compactSession } from "./compact.js";
import { config, systemPrompt } from "./config.js";
import { DiscordSender } from "./discord-sender.js";
import { log } from "./logger.js";
import { routeMessage } from "./message-router.js";
import { type SessionManager } from "./session-manager.js";
import { processTracker } from "./process-tracker.js";
import {
  downloadAttachments,
  redownloadAttachments,
  cleanupAttachments,
} from "./attachment-handler.js";
import { msg } from "./messages.js";

/**
 * Build reply context when the user replies to a previous message.
 *
 * Args:
 *   message: Discord.js Message that may contain a reference.
 *
 * Returns:
 *   Context string to prepend to the prompt, or empty string.
 */
async function buildReplyContext(message: Message): Promise<string> {
  if (!message.reference?.messageId) return "";

  try {
    const referenced = await message.channel.messages.fetch(
      message.reference.messageId,
    );
    const author = referenced.author.bot ? "Bot" : referenced.author.displayName;
    const content = referenced.content.slice(0, 1000);
    return `[답장 대상 메시지 (${author})]\n${content}\n\n`;
  } catch {
    return "";
  }
}

/**
 * Safely add a reaction, ignoring errors (e.g., missing permissions).
 */
async function safeReact(message: Message, emoji: string): Promise<void> {
  try {
    await message.react(emoji);
  } catch {
    // Ignore reaction errors (permission, unknown message, etc.)
  }
}

/**
 * Safely remove the bot's own reaction from a message.
 */
async function safeRemoveReaction(
  message: Message,
  emoji: string,
): Promise<void> {
  try {
    const reaction = message.reactions.cache.get(emoji);
    if (reaction) await reaction.users.remove(message.client.user!.id);
  } catch {
    // Ignore
  }
}

/**
 * Handle an incoming Discord message.
 *
 * Args:
 *   message: Discord.js Message object.
 *   manager: SessionManager instance.
 */
export async function handleMessage(
  message: Message,
  manager: SessionManager,
): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  // Check channel allowlist
  if (!manager.isChannelAllowed(message.channelId)) return;

  log.message(
    message.author.tag,
    message.channelId,
    message.content.slice(0, 80),
  );

  const route = routeMessage(message.content);
  log.route(route.type, route.args?.slice(0, 50));
  const sender = new DiscordSender(message);

  try {
    switch (route.type) {
      case "compact":
        await handleCompact(message.channelId, route.args, sender, manager);
        break;
      case "clear":
        await handleClear(message.channelId, sender, manager);
        break;
      case "cost":
        await handleCost(message.channelId, sender, manager);
        break;
      case "status":
        await handleStatus(message.channelId, sender, manager);
        break;
      case "model":
        await handleModel(message.channelId, route.args, sender, manager);
        break;
      case "cwd":
        await handleCwd(message.channelId, route.args, sender, manager);
        break;
      case "new":
        await handleNew(message.channelId, sender, manager);
        break;
      case "resume":
        await handleResume(message.channelId, route.args, sender, manager);
        break;
      case "help":
        await handleHelp(sender);
        break;
      case "message": {
        const { promptPrefix, metadata } = await downloadAttachments(message);
        const replyContext = await buildReplyContext(message);
        const fullPrompt = replyContext + promptPrefix + route.args!;
        await handleChatMessage(
          message,
          fullPrompt,
          sender,
          manager,
          replyContext,
          route.args!,
          metadata,
        );
        break;
      }
    }
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Unknown error occurred";
    await sender.sendReply(`❌ 오류: ${errorMsg.slice(0, 500)}`);
  }
}

async function handleChatMessage(
  message: Message,
  prompt: string,
  sender: DiscordSender,
  manager: SessionManager,
  replyContext: string,
  rawContent: string,
  attachmentMeta: { name: string; url: string; contentType: string | null }[],
): Promise<void> {
  const channelId = message.channelId;
  const session = manager.get(channelId);

  // Block concurrent requests
  if (session?.isProcessing) {
    await sender.sendReply(
      "⏳ 이전 요청 처리 중입니다. 잠시 후 다시 시도해주세요.",
    );
    return;
  }

  if (session) {
    manager.update(channelId, { isProcessing: true });
  }

  // Status reaction: processing
  await safeReact(message, "⏳");

  // Process tracking for cancel/retry
  const abortController = processTracker.startProcess(channelId, message.id);
  processTracker.setLastMessage(channelId, {
    messageId: message.id,
    content: rawContent,
    replyContext,
    attachments: attachmentMeta,
  });

  await sender.startProcessing();

  // Register bot message IDs for cancel-by-reaction
  for (const id of sender.getSentMessageIds()) {
    processTracker.addBotMessageId(channelId, id);
  }

  let cancelled = false;

  try {
    let sessionId = session?.sessionId;
    let sessionCreated = !!session;
    let resultSubtype = "";
    let resumeCount = 0;
    let currentPrompt = prompt;
    const MAX_AUTO_RESUMES = 10;
    const RESUMABLE_SUBTYPES = new Set(["error_max_turns", "error_timeout"]);

    // eslint-disable-next-line no-constant-condition
    while (true) {
    resultSubtype = "";
    let currentToolInput: Record<string, unknown> = {};
    let currentBlockType = "";
    let currentToolName = "";
    let currentToolInputRaw = "";
    let currentThinking = "";

    for await (const event of callClaude({
      prompt: currentPrompt,
      resume: sessionId,
      cwd: session?.cwd,
      model: session?.model,
      maxTurns: config.maxTurns,
      appendSystemPrompt: systemPrompt || undefined,
      signal: abortController.signal,
    })) {
      // Register new bot messages as they are created
      for (const id of sender.getSentMessageIds()) {
        processTracker.addBotMessageId(channelId, id);
      }

      // Capture session ID from init event
      if (
        event.type === "system" &&
        event.subtype === "init" &&
        event.session_id
      ) {
        sessionId = event.session_id;
        if (!sessionCreated) {
          manager.create(channelId, sessionId);
          manager.update(channelId, { isProcessing: true });
          sessionCreated = true;
        }
      }

      // Handle streaming text
      if (event.type === "stream_event" && event.event) {
        const apiEvent = event.event;

        // Text delta
        if (
          apiEvent.type === "content_block_delta" &&
          apiEvent.delta?.type === "text_delta" &&
          apiEvent.delta.text
        ) {
          await sender.appendText(apiEvent.delta.text);
        }

        // Content block start — track block type for logging
        if (apiEvent.type === "content_block_start" && apiEvent.content_block) {
          currentBlockType = apiEvent.content_block.type;

          if (apiEvent.content_block.type === "thinking") {
            currentThinking = "";
          } else if (
            apiEvent.content_block.type === "tool_use" &&
            apiEvent.content_block.name
          ) {
            currentToolName = apiEvent.content_block.name;
            currentToolInput = {};
            currentToolInputRaw = "";
          } else if (apiEvent.content_block.type === "tool_result") {
            log.toolResult(
              apiEvent.content_block.tool_use_id ?? "?",
              apiEvent.content_block.content != null
                ? String(apiEvent.content_block.content).slice(0, 500)
                : undefined,
            );
          }
        }

        // Thinking delta
        if (
          apiEvent.type === "content_block_delta" &&
          apiEvent.delta?.type === "thinking_delta" &&
          apiEvent.delta.thinking
        ) {
          currentThinking += apiEvent.delta.thinking;
        }

        // Tool input delta
        if (
          apiEvent.type === "content_block_delta" &&
          apiEvent.delta?.type === "input_json_delta" &&
          apiEvent.delta.partial_json
        ) {
          currentToolInputRaw += apiEvent.delta.partial_json;
          try {
            const partial = JSON.parse(apiEvent.delta.partial_json);
            Object.assign(currentToolInput, partial);
          } catch {
            // Partial JSON not yet parseable
          }
        }

        // Content block stop — log completed blocks and flush text
        if (apiEvent.type === "content_block_stop") {
          if (currentBlockType === "thinking" && currentThinking) {
            log.thinking(currentThinking);
          } else if (currentBlockType === "tool_use" && currentToolName) {
            let parsed: unknown = currentToolInput;
            try {
              parsed = JSON.parse(currentToolInputRaw);
            } catch {
              /* use accumulated object */
            }
            log.tool(currentToolName, parsed as Record<string, unknown>);
          } else if (currentBlockType === "text") {
            // Flush text block immediately so each block becomes its own message
            await sender.flush();
          }
          currentBlockType = "";
        }
      }

      // Handle result
      if (event.type === "result") {
        resultSubtype = event.subtype ?? "success";
        if (event.usage) {
          manager.addUsage(
            channelId,
            event.usage.input_tokens,
            event.usage.output_tokens,
          );
          log.usage(event.usage.input_tokens, event.usage.output_tokens);
        }
      }

    }

    // Auto-resume if the CLI stopped due to turn/time limits
    if (
      RESUMABLE_SUBTYPES.has(resultSubtype) &&
      resumeCount < MAX_AUTO_RESUMES &&
      !abortController.signal.aborted &&
      sessionId
    ) {
      resumeCount++;
      currentPrompt = "이어서 진행해줘.";
      log.debug(
        `Auto-resume (${resumeCount}/${MAX_AUTO_RESUMES}): ${resultSubtype}`,
      );
      continue;
    }

    break;
    } // end while

    // === Final response ===
    await safeRemoveReaction(message, "⏳");

    if (abortController.signal.aborted) {
      cancelled = true;
      await safeReact(message, "⚠️");
      await sender.sendReply("⚠️ 요청이 취소되었습니다.");
    } else {
      await sender.finish();
      await safeReact(message, "✅");
    }
  } catch (err) {
    cancelled = abortController.signal.aborted;

    await safeRemoveReaction(message, "⏳");

    if (cancelled) {
      await safeReact(message, "⚠️");
      await sender.sendReply("⚠️ 요청이 취소되었습니다.");
    } else {
      await safeReact(message, "❌");
      const errorMsg =
        err instanceof Error ? err.message : "Unknown error occurred";
      await sender.sendReply(`❌ 오류: ${errorMsg.slice(0, 500)}`);
    }
  } finally {
    processTracker.finishProcess(channelId);
    cleanupAttachments(message.id);
    manager.update(channelId, {
      isProcessing: false,
      lastActivity: new Date().toISOString(),
    });
  }
}

/**
 * Handle a reaction added to a message.
 *
 * Supports:
 *   - ❌ on a processing message → cancel the active CLI process
 *   - 🔄 on the user's own previous message → retry
 *
 * Args:
 *   reaction: Discord.js MessageReaction (may be partial).
 *   user: The user who added the reaction (may be partial).
 *   manager: SessionManager instance.
 */
export async function handleReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  manager: SessionManager,
): Promise<void> {
  // Ignore bot's own reactions
  if (user.bot) return;

  // Fetch partials
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return;
    }
  }
  if (reaction.message.partial) {
    try {
      await reaction.message.fetch();
    } catch {
      return;
    }
  }

  const channelId = reaction.message.channelId;

  // Check channel allowlist
  if (!manager.isChannelAllowed(channelId)) return;

  const emoji = reaction.emoji.name;

  if (emoji === "❌") {
    await handleCancelReaction(channelId, reaction.message.id);
  } else if (emoji === "🔄") {
    await handleRetryReaction(
      reaction.message as Message,
      user,
      manager,
    );
  }
}

async function handleCancelReaction(
  channelId: string,
  messageId: string,
): Promise<void> {
  if (!processTracker.isProcessMessage(channelId, messageId)) return;

  const cancelled = processTracker.cancelProcess(channelId);
  if (cancelled) {
    log.cancel(channelId);
  }
}

async function handleRetryReaction(
  message: Message,
  user: User | PartialUser,
  manager: SessionManager,
): Promise<void> {
  const channelId = message.channelId;
  const lastMessage = processTracker.getLastMessage(channelId);

  // Only retry if reacting on the original user message
  if (!lastMessage || lastMessage.messageId !== message.id) return;

  // Don't retry if the message author isn't the reactor
  if (message.author.id !== user.id) return;

  // Don't retry while processing
  const session = manager.get(channelId);
  if (session?.isProcessing) return;

  log.retry(message.id, channelId);

  // Re-download attachments if there were any
  const { promptPrefix } = await redownloadAttachments(
    message.id,
    lastMessage.attachments,
  );

  const fullPrompt =
    lastMessage.replyContext + promptPrefix + lastMessage.content;
  const sender = new DiscordSender(message);

  await handleChatMessage(
    message,
    fullPrompt,
    sender,
    manager,
    lastMessage.replyContext,
    lastMessage.content,
    lastMessage.attachments,
  );
}

async function handleCompact(
  channelId: string,
  focusHint: string | undefined,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  const session = manager.get(channelId);
  if (!session) {
    await sender.sendReply("❌ 활성 세션이 없습니다. 먼저 메시지를 보내주세요.");
    return;
  }

  await sender.sendReply("🔄 컨텍스트 압축 중...");

  const result = await compactSession(manager, channelId, focusHint);

  const lines = [
    "✅ 컨텍스트 압축 완료",
    `이전 세션 토큰: ~${result.previousInputTokens.toLocaleString()} input / ~${result.previousOutputTokens.toLocaleString()} output`,
    `새 세션으로 전환됨 (요약 ${result.summaryLength.toLocaleString()}자)`,
  ];

  await sender.sendReply(lines.join("\n"));
}

async function handleNew(
  channelId: string,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  const session = manager.get(channelId);
  if (session) {
    manager.archive(channelId);
    await sender.sendReply(
      `✅ 이전 세션 \`${session.sessionId.slice(0, 8)}...\`을 보관하고 새 세션을 시작합니다.`,
    );
  } else {
    await sender.sendReply("✅ 새 세션을 시작합니다. 다음 메시지부터 새 세션이 생성됩니다.");
  }
}

async function handleResume(
  channelId: string,
  sessionIdPrefix: string | undefined,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  const history = manager.getHistory(channelId);

  if (!sessionIdPrefix) {
    if (history.length === 0) {
      await sender.sendReply("❌ 이전 세션 기록이 없습니다.");
      return;
    }

    const lines = ["📋 **이전 세션 목록**", ""];
    for (const s of history) {
      const date = new Date(s.lastActivity);
      lines.push(
        `\`${s.sessionId.slice(0, 8)}\` — ${s.model} | ${s.turnCount}턴 | ${date.toLocaleString("ko-KR")}`,
      );
    }
    lines.push("", "사용법: `/resume <세션ID 앞 8자리>`");
    await sender.sendReply(lines.join("\n"));
    return;
  }

  const restored = manager.restore(channelId, sessionIdPrefix);
  if (!restored) {
    await sender.sendReply(
      `❌ \`${sessionIdPrefix}\`로 시작하는 세션을 찾을 수 없습니다.`,
    );
    return;
  }

  await sender.sendReply(
    `✅ 세션 \`${restored.sessionId.slice(0, 8)}...\` 복원 완료. 이전 대화를 이어갑니다.`,
  );
}

async function handleClear(
  channelId: string,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  manager.delete(channelId);
  await sender.sendReply(
    msg("sessionCleared"),
  );
}

async function handleCost(
  channelId: string,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  const session = manager.get(channelId);
  if (!session) {
    await sender.sendReply("❌ 활성 세션이 없습니다.");
    return;
  }

  const lastActivity = new Date(session.lastActivity);
  const minutesAgo = Math.round(
    (Date.now() - lastActivity.getTime()) / 60000,
  );

  const lines = [
    "📊 **현재 세션 사용량**",
    `입력: ${session.totalInputTokens.toLocaleString()} tokens`,
    `출력: ${session.totalOutputTokens.toLocaleString()} tokens`,
    `총 턴 수: ${session.turnCount}`,
    `마지막 활동: ${minutesAgo}분 전`,
  ];

  await sender.sendReply(lines.join("\n"));
}

async function handleStatus(
  channelId: string,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  const session = manager.get(channelId);
  if (!session) {
    await sender.sendReply("❌ 활성 세션이 없습니다.");
    return;
  }

  const lines = [
    "📋 **세션 상태**",
    `세션 ID: \`${session.sessionId.slice(0, 8)}...\``,
    `모델: ${session.model}`,
    `작업 디렉토리: \`${session.cwd}\``,
    `입력 토큰: ${session.totalInputTokens.toLocaleString()}`,
    `출력 토큰: ${session.totalOutputTokens.toLocaleString()}`,
    `턴 수: ${session.turnCount}`,
    `처리 중: ${session.isProcessing ? "예" : "아니오"}`,
    session.conversationSummary
      ? `요약 보유: 예 (${session.conversationSummary.length}자)`
      : "요약 보유: 아니오",
  ];

  await sender.sendReply(lines.join("\n"));
}

async function handleModel(
  channelId: string,
  modelArg: string | undefined,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  if (!modelArg) {
    const session = manager.get(channelId);
    await sender.sendReply(
      `현재 모델: ${session?.model ?? config.defaultModel}\n사용법: \`/model <name>\` (예: sonnet, opus, haiku)`,
    );
    return;
  }

  // Resolve short names
  const modelMap: Record<string, string> = {
    sonnet: "claude-sonnet-4-6",
    opus: "claude-opus-4-6",
    haiku: "claude-haiku-4-5-20251001",
  };
  const resolved = modelMap[modelArg] ?? modelArg;

  const session = manager.get(channelId);
  if (!session) {
    await sender.sendReply(
      `✅ 모델이 \`${resolved}\`로 설정되었습니다. 다음 메시지부터 적용됩니다.`,
    );
    return;
  }

  manager.update(channelId, { model: resolved });
  await sender.sendReply(`✅ 모델 변경: \`${resolved}\``);
}

async function handleCwd(
  channelId: string,
  cwdArg: string | undefined,
  sender: DiscordSender,
  manager: SessionManager,
): Promise<void> {
  if (!cwdArg) {
    const session = manager.get(channelId);
    await sender.sendReply(
      `현재 작업 디렉토리: \`${session?.cwd ?? config.defaultCwd}\`\n사용법: \`/cwd /path/to/dir\``,
    );
    return;
  }

  const session = manager.get(channelId);
  if (!session) {
    await sender.sendReply(
      `✅ 작업 디렉토리가 \`${cwdArg}\`로 설정되었습니다. 다음 메시지부터 적용됩니다.`,
    );
    return;
  }

  manager.update(channelId, { cwd: cwdArg });
  await sender.sendReply(`✅ 작업 디렉토리 변경: \`${cwdArg}\``);
}

async function handleHelp(sender: DiscordSender): Promise<void> {
  const lines = [
    "📖 **사용 가능한 명령어**",
    "",
    "`/new` — 새 세션 시작 (이전 세션은 보관)",
    "`/resume [세션ID]` — 이전 세션 목록 조회 / 복원",
    "`/compact [힌트]` — 컨텍스트 압축 (선택적 포커스 힌트)",
    "`/clear` — 세션 초기화 (보관하지 않고 삭제)",
    "`/cost` — 토큰 사용량 조회",
    "`/status` — 세션 상태 조회",
    "`/model <name>` — 모델 변경 (sonnet, opus, haiku)",
    "`/cwd <path>` — 작업 디렉토리 변경",
    "`/help` — 이 도움말 표시",
    "",
    "그 외 메시지는 Claude에게 전달됩니다.",
    "세션이 있으면 자동으로 이전 대화를 이어갑니다.",
    "",
    "**리액션:**",
    "❌ — 처리 중인 요청 취소",
    "🔄 — 마지막 메시지 재시도",
  ];

  await sender.sendReply(lines.join("\n"));
}
