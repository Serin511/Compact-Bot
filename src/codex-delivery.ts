/**
 * Turn-scoped delivery tracking for Codex chat sessions.
 *
 * Codex is instructed to answer through the platform MCP `reply` tool. If a
 * turn finishes without a successful reply to the exact originating target,
 * Compact Bot forwards the final agent message as a fallback. Keeping this
 * state machine separate from the wrapper makes the routing rules testable
 * without starting Discord, Slack, or the wrapper process.
 */

import {
  sameConversationOrigin,
  type IpcOrigin,
} from "./ipc.js";

export interface CodexFallbackReply {
  origin: IpcOrigin;
  text: string;
}

interface CodexTurnDelivery {
  origin: IpcOrigin | null;
  finalText: string;
  unknownPhaseText: string;
  platformReplySucceeded: boolean;
  platformReplyTexts: Set<string>;
  pendingReplyItems: Record<string, unknown>[];
  completionParams: Record<string, unknown> | null;
  provisionalOriginAmbiguous: boolean;
  /**
   * A turn can start and even complete before an explicit `turn/start`
   * response identifies which turn accepted the input. Keep those turns
   * unresolved until the authoritative response classifies them.
   */
  provisionalSubmissionToken: number | null;
}

export interface CodexExplicitSubmission {
  readonly token: number;
  readonly origin: IpcOrigin;
  readonly previousOrigin: IpcOrigin | null;
}

export interface CodexGoalOriginSnapshot {
  readonly origin: IpcOrigin | null;
  readonly active: boolean;
}

/**
 * Only the exact owning conversation may steer or reuse an active Codex turn.
 *
 * A missing owner is deliberately denied: during notification/response races,
 * treating an unclassified turn as shared would let another allowlisted
 * conversation inject text into it.
 */
export function canUseActiveCodexTurn(
  owner: IpcOrigin | null,
  origin: IpcOrigin | undefined,
): boolean {
  return (
    owner !== null &&
    origin !== undefined &&
    sameConversationOrigin(owner, origin)
  );
}

/** Only the owning conversation may mutate a still-resumable native goal. */
export function canMutateCodexGoal(
  snapshot: CodexGoalOriginSnapshot,
  origin: IpcOrigin | undefined,
): boolean {
  if (!snapshot.active) return true;
  return (
    snapshot.origin !== null &&
    origin !== undefined &&
    sameConversationOrigin(snapshot.origin, origin)
  );
}

const MAX_COMPLETED_TURN_IDS = 256;
const TERMINAL_GOAL_STATUSES = new Set([
  "complete",
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

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

function successfulReplyText(
  item: Record<string, unknown>,
  origin: IpcOrigin,
): string | null | undefined {
  if (
    item.type !== "mcpToolCall" ||
    item.tool !== "reply" ||
    item.status !== "completed" ||
    item.error != null
  ) {
    return undefined;
  }

  const expectedServer = `compact_bot_${origin.source}`;
  if (item.server !== expectedServer) return undefined;

  const args =
    item.arguments && typeof item.arguments === "object"
      ? (item.arguments as Record<string, unknown>)
      : {};
  if (args.chat_id !== origin.chat_id) return undefined;
  if (
    origin.source === "slack" &&
    (typeof args.thread_ts === "string" ? args.thread_ts : "") !==
      (origin.thread_ts ?? "")
  ) {
    return undefined;
  }

  const result =
    item.result && typeof item.result === "object"
      ? (item.result as Record<string, unknown>)
      : {};
  if (result.isError === true) return undefined;
  const text = typeof args.text === "string" ? args.text.trim() : "";
  return text || null;
}

export class CodexDeliveryTracker {
  private currentOrigin: IpcOrigin | null = null;
  private goalOrigin: IpcOrigin | null = null;
  private goalActive = false;
  private nextSubmissionToken = 1;
  private pendingExplicitSubmission: CodexExplicitSubmission | null = null;
  private readonly deliveries = new Map<string, CodexTurnDelivery>();
  private readonly completedTurnIds = new Set<string>();

  /** Remember the fallback target for the next turn notification. */
  setCurrentOrigin(origin: IpcOrigin | null): void {
    if (origin) this.currentOrigin = origin;
  }

  /**
   * Keep an automatic goal loop owned by the conversation that created it.
   *
   * Ordinary messages must not overwrite this value: a later message may steer
   * one goal turn, but subsequent automatic turns still belong to the goal
   * creator.
   */
  setGoalOrigin(origin: IpcOrigin | null): void {
    this.goalOrigin = origin;
    this.goalActive = origin !== null;
  }

  snapshotGoalOrigin(): CodexGoalOriginSnapshot {
    return { origin: this.goalOrigin, active: this.goalActive };
  }

  restoreGoalOrigin(snapshot: CodexGoalOriginSnapshot): void {
    this.goalOrigin = snapshot.origin;
    this.goalActive = snapshot.active;
  }

  /**
   * Stage an explicit user-message origin before app-server has returned a turn
   * id. Notifications and server requests can arrive during this window.
   */
  beginExplicitSubmission(origin: IpcOrigin): CodexExplicitSubmission {
    if (this.pendingExplicitSubmission) {
      this.cancelExplicitSubmission(this.pendingExplicitSubmission);
    }
    const submission: CodexExplicitSubmission = {
      token: this.nextSubmissionToken++,
      origin,
      previousOrigin: this.currentOrigin,
    };
    this.pendingExplicitSubmission = submission;
    return submission;
  }

  /**
   * Commit an explicit submission to the authoritative accepted turn id.
   * Safe to call from both the response observer and the resolved submit call.
   */
  acceptExplicitSubmission(
    submission: CodexExplicitSubmission,
    turnId: string,
  ): CodexFallbackReply[] {
    const fallbacks: CodexFallbackReply[] = [];
    if (this.pendingExplicitSubmission === submission) {
      this.pendingExplicitSubmission = null;
      for (const [candidateTurnId, delivery] of [...this.deliveries]) {
        if (delivery.provisionalSubmissionToken !== submission.token) continue;
        const resolvedOrigin =
          candidateTurnId === turnId
            ? submission.origin
            : (this.goalActive ? this.goalOrigin : null) ??
              submission.previousOrigin;
        this.resolveProvisionalDelivery(delivery, resolvedOrigin);
        const fallback = this.finishBufferedDelivery(
          candidateTurnId,
          delivery,
        );
        if (fallback) fallbacks.push(fallback);
      }
    }
    this.currentOrigin = submission.origin;
    this.setOriginForTurn(turnId, submission.origin);
    return fallbacks;
  }

  /** Roll back an explicit origin when app-server rejects the submission. */
  cancelExplicitSubmission(
    submission: CodexExplicitSubmission,
  ): CodexFallbackReply[] {
    if (this.pendingExplicitSubmission !== submission) return [];
    this.pendingExplicitSubmission = null;
    const fallbacks: CodexFallbackReply[] = [];
    for (const [turnId, delivery] of [...this.deliveries]) {
      if (delivery.provisionalSubmissionToken !== submission.token) continue;
      const restoredOrigin =
        (this.goalActive ? this.goalOrigin : null) ??
        submission.previousOrigin;
      this.resolveProvisionalDelivery(delivery, restoredOrigin);
      const fallback = this.finishBufferedDelivery(turnId, delivery);
      if (fallback) fallbacks.push(fallback);
    }
    return fallbacks;
  }

  /**
   * Bind a successfully submitted input to the actual turn id returned by
   * app-server. This survives a delayed `turn/started` notification.
   */
  setOriginForTurn(turnId: string, origin: IpcOrigin): void {
    // turn/completed can precede the turn/start response. The wrapper binds the
    // returned id after submit resolves; do not recreate state already consumed
    // by the completion notification.
    if (this.completedTurnIds.has(turnId)) return;
    const delivery =
      this.deliveries.get(turnId) ?? this.emptyDelivery(null);
    if (!sameOrigin(delivery.origin, origin)) {
      // A reply sent before a later steer only satisfies the previous input.
      delivery.platformReplySucceeded = false;
      delivery.platformReplyTexts.clear();
    }
    delivery.origin = origin;
    delivery.provisionalSubmissionToken = null;
    delivery.provisionalOriginAmbiguous = false;
    this.consumePendingReplyItems(delivery);
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
    const delivery = turnId ? this.deliveries.get(turnId) : undefined;
    // A question from an unresolved turn cannot safely be shown in either the
    // goal owner's conversation or the pending sender's conversation.
    if (delivery?.provisionalOriginAmbiguous) return null;
    // A known turn with no owner was deliberately classified as ambiguous or
    // ownerless. Never replace that fail-closed result with whichever channel
    // happened to become current later.
    if (delivery) return delivery.origin;
    if (
      this.goalActive &&
      this.pendingExplicitSubmission
    ) {
      return null;
    }
    // An active native goal without a known creator must also stay ownerless.
    // Falling through to currentOrigin would expose its questions or output to
    // an unrelated user who merely sent the most recent channel message.
    if (this.goalActive) return this.goalOrigin;
    return this.pendingExplicitSubmission?.origin ?? this.currentOrigin;
  }

  /**
   * Return only an exact, fully classified turn owner for outbound writes.
   *
   * Unlike question routing, authorization must never fall back to a current
   * or pending conversation: doing so could permit an automatic goal turn to
   * write into a concurrently submitted conversation.
   */
  authorizationOriginForTurn(turnId: string): IpcOrigin | null {
    const delivery = this.deliveries.get(turnId);
    if (
      !delivery ||
      delivery.provisionalSubmissionToken !== null ||
      delivery.provisionalOriginAmbiguous
    ) {
      return null;
    }
    return delivery.origin;
  }

  /** Drop every conversation owner when a Codex session is replaced. */
  clearTurns(): void {
    this.deliveries.clear();
    this.completedTurnIds.clear();
    this.pendingExplicitSubmission = null;
    this.currentOrigin = null;
    this.goalOrigin = null;
    this.goalActive = false;
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
    if (method === "thread/goal/cleared") {
      this.goalOrigin = null;
      this.goalActive = false;
      return null;
    }
    if (method === "thread/goal/updated") {
      const goal =
        params.goal && typeof params.goal === "object"
          ? (params.goal as Record<string, unknown>)
          : {};
      const status = typeof goal.status === "string" ? goal.status : "";
      if (TERMINAL_GOAL_STATUSES.has(status)) {
        this.goalActive = false;
        this.goalOrigin = null;
      } else if (
        ["active", "paused", "blocked", "usageLimited", "budgetLimited"]
          .includes(status)
      ) {
        // Non-terminal goals can be resumed by Codex later. Retain their
        // conversation owner even while no automatic turn is running.
        this.goalActive = true;
      }
      return null;
    }

    const turnId = turnIdFromNotification(params);
    if (!turnId) return null;
    if (this.completedTurnIds.has(turnId) && method !== "turn/completed") {
      return null;
    }

    if (method === "turn/started") {
      // `turn/start` can return before this notification is delivered. Keep an
      // origin explicitly bound to its returned turn id instead of replacing
      // it with whichever channel most recently became current.
      if (!this.deliveries.has(turnId)) {
        const pending = this.pendingExplicitSubmission;
        const usePending = !this.goalActive && pending !== null;
        this.deliveries.set(
          turnId,
          this.emptyDelivery(
            usePending ? pending.origin : this.automaticTurnOrigin(),
            pending?.token ?? null,
            this.goalActive && pending !== null,
          ),
        );
      }
      return null;
    }

    if (method === "item/completed") {
      const item =
        params.item && typeof params.item === "object"
          ? (params.item as Record<string, unknown>)
          : null;
      if (!item) return null;

      const pending = this.pendingExplicitSubmission;
      const usePending = !this.goalActive && pending !== null;
      const delivery =
        this.deliveries.get(turnId) ??
        this.emptyDelivery(
          usePending ? pending.origin : this.automaticTurnOrigin(),
          pending?.token ?? null,
          this.goalActive && pending !== null,
        );
      if (item.type === "agentMessage" && typeof item.text === "string") {
        if (item.phase === "final_answer") {
          delivery.finalText = item.text;
        } else if (item.phase !== "commentary") {
          delivery.unknownPhaseText = item.text;
        }
      } else if (item.type === "mcpToolCall") {
        if (delivery.provisionalSubmissionToken !== null) {
          delivery.pendingReplyItems.push(item);
        } else {
          this.consumeReplyItem(delivery, item);
        }
      }
      this.deliveries.set(turnId, delivery);
      return null;
    }

    if (method !== "turn/completed") return null;

    this.rememberCompletedTurn(turnId);
    const pending = this.pendingExplicitSubmission;
    const delivery =
      this.deliveries.get(turnId) ??
      (pending
        ? this.emptyDelivery(
          this.goalActive ? this.goalOrigin : pending.origin,
          pending.token,
          this.goalActive,
        )
        : undefined);
    if (
      delivery &&
      pending &&
      delivery.provisionalSubmissionToken === pending.token
    ) {
      // The response to turn/start is authoritative. Buffer completion so an
      // explicit turn is not sent to the goal owner, and an automatic goal
      // turn is not leaked to the pending sender.
      delivery.completionParams = params;
      this.deliveries.set(turnId, delivery);
      return null;
    }
    if (!delivery) return null;
    return this.finishDelivery(turnId, delivery, params);
  }

  private emptyDelivery(
    origin: IpcOrigin | null,
    provisionalSubmissionToken: number | null = null,
    provisionalOriginAmbiguous = false,
  ): CodexTurnDelivery {
    return {
      origin,
      finalText: "",
      unknownPhaseText: "",
      platformReplySucceeded: false,
      platformReplyTexts: new Set<string>(),
      pendingReplyItems: [],
      completionParams: null,
      provisionalOriginAmbiguous,
      provisionalSubmissionToken,
    };
  }

  private automaticTurnOrigin(): IpcOrigin | null {
    return this.goalActive ? this.goalOrigin : this.currentOrigin;
  }

  private resolveProvisionalDelivery(
    delivery: CodexTurnDelivery,
    origin: IpcOrigin | null,
  ): void {
    if (
      origin === null ||
      delivery.origin === null ||
      !sameOrigin(delivery.origin, origin)
    ) {
      delivery.platformReplySucceeded = false;
      delivery.platformReplyTexts.clear();
    }
    delivery.origin = origin;
    delivery.provisionalSubmissionToken = null;
    delivery.provisionalOriginAmbiguous = false;
    this.consumePendingReplyItems(delivery);
  }

  private consumePendingReplyItems(delivery: CodexTurnDelivery): void {
    for (const item of delivery.pendingReplyItems) {
      this.consumeReplyItem(delivery, item);
    }
    delivery.pendingReplyItems.length = 0;
  }

  private consumeReplyItem(
    delivery: CodexTurnDelivery,
    item: Record<string, unknown>,
  ): void {
    if (!delivery.origin) return;
    const replyText = successfulReplyText(item, delivery.origin);
    if (replyText !== undefined) delivery.platformReplySucceeded = true;
    if (replyText) delivery.platformReplyTexts.add(replyText);
  }

  private finishBufferedDelivery(
    turnId: string,
    delivery: CodexTurnDelivery,
  ): CodexFallbackReply | null {
    if (!delivery.completionParams) return null;
    return this.finishDelivery(turnId, delivery, delivery.completionParams);
  }

  private finishDelivery(
    turnId: string,
    delivery: CodexTurnDelivery,
    completionParams: Record<string, unknown>,
  ): CodexFallbackReply | null {
    this.deliveries.delete(turnId);
    if (!delivery.origin) return null;

    const text = (delivery.finalText || delivery.unknownPhaseText).trim();
    if (text && delivery.platformReplyTexts.has(text)) return null;
    if (text) return { origin: delivery.origin, text };
    if (delivery.platformReplySucceeded) return null;

    const failure = turnFailureMessage(completionParams);
    if (!failure || delivery.platformReplyTexts.has(failure)) return null;
    return { origin: delivery.origin, text: failure };
  }

  private rememberCompletedTurn(turnId: string): void {
    this.completedTurnIds.add(turnId);
    while (this.completedTurnIds.size > MAX_COMPLETED_TURN_IDS) {
      const oldest = this.completedTurnIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.completedTurnIds.delete(oldest);
    }
  }
}
