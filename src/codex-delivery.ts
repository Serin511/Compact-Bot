/**
 * Turn-scoped delivery tracking for Codex chat sessions.
 *
 * Codex is instructed to answer through the platform MCP `reply` tool. If a
 * turn finishes without a successful reply to the exact originating target,
 * Compact Bot forwards the final agent message as a fallback. Keeping this
 * state machine separate from the wrapper makes the routing rules testable
 * without starting Discord, Slack, or the wrapper process.
 */

import type { IpcOrigin } from "./ipc.js";

export interface CodexFallbackReply {
  origin: IpcOrigin;
  text: string;
}

interface CodexTurnDelivery {
  origin: IpcOrigin | null;
  finalText: string;
  unknownPhaseText: string;
  platformReplySucceeded: boolean;
}

function turnIdFromNotification(
  params: Record<string, unknown>,
): string | undefined {
  if (typeof params.turnId === "string") return params.turnId;
  if (!params.turn || typeof params.turn !== "object") return undefined;
  const turnId = (params.turn as Record<string, unknown>).id;
  return typeof turnId === "string" ? turnId : undefined;
}

function sameOrigin(left: IpcOrigin | null, right: IpcOrigin): boolean {
  return (
    left?.source === right.source &&
    left.chat_id === right.chat_id &&
    left.message_id === right.message_id &&
    left.user === right.user &&
    left.ts === right.ts &&
    left.thread_ts === right.thread_ts
  );
}

function turnFailureMessage(
  params: Record<string, unknown>,
): string | null {
  const turn =
    params.turn && typeof params.turn === "object"
      ? (params.turn as Record<string, unknown>)
      : {};
  const status = typeof turn.status === "string" ? turn.status : "";
  const rawError = turn.error ?? params.error;
  const failed = status === "failed" || status === "error" || rawError != null;
  if (!failed) return null;

  const detail =
    rawError && typeof rawError === "object" &&
      typeof (rawError as Record<string, unknown>).message === "string"
      ? String((rawError as Record<string, unknown>).message).trim()
      : typeof rawError === "string"
        ? rawError.trim()
        : "";
  return detail
    ? `⚠️ Codex 턴이 실패했습니다: ${detail}`
    : "⚠️ Codex 턴이 실패했습니다.";
}

function isSuccessfulReply(
  item: Record<string, unknown>,
  origin: IpcOrigin,
): boolean {
  if (
    item.type !== "mcpToolCall" ||
    item.tool !== "reply" ||
    item.status !== "completed" ||
    item.error != null
  ) {
    return false;
  }

  const expectedServer = `compact_bot_${origin.source}`;
  if (item.server !== expectedServer) return false;

  const args =
    item.arguments && typeof item.arguments === "object"
      ? (item.arguments as Record<string, unknown>)
      : {};
  if (args.chat_id !== origin.chat_id) return false;
  if (
    origin.source === "slack" &&
    (typeof args.thread_ts === "string" ? args.thread_ts : "") !==
      (origin.thread_ts ?? "")
  ) {
    return false;
  }

  const result =
    item.result && typeof item.result === "object"
      ? (item.result as Record<string, unknown>)
      : {};
  return result.isError !== true;
}

export class CodexDeliveryTracker {
  private currentOrigin: IpcOrigin | null = null;
  private readonly deliveries = new Map<string, CodexTurnDelivery>();

  /** Remember the fallback target for the next turn notification. */
  setCurrentOrigin(origin: IpcOrigin | null): void {
    if (origin) this.currentOrigin = origin;
  }

  /**
   * Bind a successfully submitted input to the actual turn id returned by
   * app-server. This survives a delayed `turn/started` notification.
   */
  setOriginForTurn(turnId: string, origin: IpcOrigin): void {
    const delivery =
      this.deliveries.get(turnId) ?? this.emptyDelivery(null);
    if (!sameOrigin(delivery.origin, origin)) {
      // A reply sent before a later steer only satisfies the previous input.
      delivery.platformReplySucceeded = false;
    }
    delivery.origin = origin;
    this.deliveries.set(turnId, delivery);
  }

  /**
   * Remember the target for the next turn and, when steering an active turn,
   * update that turn's fallback destination.
   */
  setOrigin(origin: IpcOrigin | null, activeTurnId?: string | null): void {
    if (!origin) return;
    this.setCurrentOrigin(origin);
    if (!activeTurnId) return;
    this.setOriginForTurn(activeTurnId, origin);
  }

  /** Resolve a question or approval to its owning turn, then current target. */
  originForTurn(turnId?: string): IpcOrigin | null {
    return (turnId ? this.deliveries.get(turnId)?.origin : null) ??
      this.currentOrigin;
  }

  /** Drop per-turn state during a session change while retaining command origin. */
  clearTurns(): void {
    this.deliveries.clear();
  }

  /**
   * Consume one app-server notification.
   *
   * Returns a fallback when a completed turn has visible final text, or when a
   * failed turn has no text of its own, and no successful MCP reply reached the
   * exact source/channel/thread target.
   */
  observe(
    method: string,
    params: Record<string, unknown>,
  ): CodexFallbackReply | null {
    const turnId = turnIdFromNotification(params);
    if (!turnId) return null;

    if (method === "turn/started") {
      // `turn/start` can return before this notification is delivered. Keep an
      // origin explicitly bound to its returned turn id instead of replacing
      // it with whichever channel most recently became current.
      if (!this.deliveries.has(turnId)) {
        this.deliveries.set(turnId, this.emptyDelivery(this.currentOrigin));
      }
      return null;
    }

    if (method === "item/completed") {
      const item =
        params.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      if (!item) return null;

      const delivery =
        this.deliveries.get(turnId) ?? this.emptyDelivery(this.currentOrigin);
      if (item.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") {
          delivery.finalText = item.text;
        } else if (item.phase !== "commentary") {
          delivery.unknownPhaseText = item.text;
        }
      } else if (
        delivery.origin &&
        isSuccessfulReply(item, delivery.origin)
      ) {
        delivery.platformReplySucceeded = true;
      }
      this.deliveries.set(turnId, delivery);
      return null;
    }

    if (method !== "turn/completed") return null;

    const delivery = this.deliveries.get(turnId);
    this.deliveries.delete(turnId);
    if (!delivery?.origin || delivery.platformReplySucceeded) return null;

    const text = (delivery.finalText || delivery.unknownPhaseText).trim();
    if (text) return { origin: delivery.origin, text };

    const failure = turnFailureMessage(params);
    return failure ? { origin: delivery.origin, text: failure } : null;
  }

  private emptyDelivery(origin: IpcOrigin | null): CodexTurnDelivery {
    return {
      origin,
      finalText: "",
      unknownPhaseText: "",
      platformReplySucceeded: false,
    };
  }
}
