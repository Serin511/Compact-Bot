/**
 * Fail-closed authorization for Codex platform conversation tools.
 *
 * Codex app-server reports every MCP invocation through `item/started` with
 * the owning turn id and exact arguments. Platform MCP processes independently
 * receive the actual tools/call request over stdio. This guard joins those two
 * streams with a canonical, one-shot permit so a turn cannot read from or
 * write to a different allowlisted conversation.
 */

import { createHash } from "node:crypto";
import type { IpcOrigin } from "./ipc.js";

export type CodexPlatformSource = IpcOrigin["source"];
export type CodexWriteTool =
  | "reply"
  | "react"
  | "edit_message"
  | "fetch_messages"
  | "download_attachment";

export interface CodexOutboundCall {
  source: CodexPlatformSource;
  server: string;
  tool: CodexWriteTool;
  arguments: Record<string, unknown>;
}

export interface CodexOutboundDecision {
  ok: boolean;
  error?: string;
}

interface GuardItem {
  itemId: string;
  turnId: string;
  key: string;
  call: CodexOutboundCall;
  decision: CodexOutboundDecision | null;
  waiter: GuardWaiter | null;
  timeout: ReturnType<typeof setTimeout>;
}

interface GuardWaiter {
  key: string;
  resolve: (decision: CodexOutboundDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
  item: GuardItem | null;
  settled: boolean;
}

export interface CodexOutboundGuardOptions {
  authorizationTimeoutMs?: number;
  itemTtlMs?: number;
}

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5_000;
const DEFAULT_ITEM_TTL_MS = 30_000;
const GUARDED_TOOLS = new Set<CodexWriteTool>([
  "reply",
  "react",
  "edit_message",
  "fetch_messages",
  "download_attachment",
]);

function normalizedJson(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : normalizedJson(item)
    );
  }
  if (typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (
        item === undefined ||
        typeof item === "function" ||
        typeof item === "symbol"
      ) {
        continue;
      }
      normalized[key] = normalizedJson(item);
    }
    return normalized;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return null;
}

/**
 * Stable identity for one concrete MCP invocation.
 *
 * Object key order is irrelevant while array order remains significant. The
 * platform, MCP server, and tool are part of the digest so identical argument
 * objects cannot cross-consume another server's permit.
 */
export function codexOutboundCallFingerprint(
  call: CodexOutboundCall,
): string {
  const canonical = JSON.stringify(normalizedJson({
    source: call.source,
    server: call.server,
    tool: call.tool,
    arguments: call.arguments,
  }));
  return createHash("sha256").update(canonical).digest("hex");
}

function sourceForServer(server: unknown): CodexPlatformSource | null {
  if (server === "compact_bot_discord") return "discord";
  if (server === "compact_bot_slack") return "slack";
  return null;
}

function guardedTool(value: unknown): CodexWriteTool | null {
  return typeof value === "string" &&
      GUARDED_TOOLS.has(value as CodexWriteTool)
    ? value as CodexWriteTool
    : null;
}

function turnIdFromParams(
  params: Record<string, unknown>,
): string | null {
  if (typeof params.turnId === "string") return params.turnId;
  const turn =
    params.turn && typeof params.turn === "object"
      ? params.turn as Record<string, unknown>
      : null;
  return typeof turn?.id === "string" ? turn.id : null;
}

function itemFromParams(
  params: Record<string, unknown>,
): Record<string, unknown> | null {
  return params.item && typeof params.item === "object"
    ? params.item as Record<string, unknown>
    : null;
}

/**
 * One-shot MCP conversation-tool permits derived from app-server items.
 *
 * An authorization request may arrive before or after `item/started`. Unknown
 * or provisionally-owned turns stay pending until `reconcile()` is called,
 * then fail closed on completion, reset, or timeout.
 */
export class CodexOutboundWriteGuard {
  private readonly authorizationTimeoutMs: number;
  private readonly itemTtlMs: number;
  private readonly itemsById = new Map<string, GuardItem>();
  private readonly itemsByKey = new Map<string, GuardItem[]>();
  private readonly waitersByKey = new Map<string, GuardWaiter[]>();
  private readonly ambiguityTokens = new Set<number>();
  private nextAmbiguityToken = 1;

  constructor(
    private readonly resolveOrigin: (turnId: string) => IpcOrigin | null,
    options: CodexOutboundGuardOptions = {},
  ) {
    this.authorizationTimeoutMs =
      options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
    this.itemTtlMs = options.itemTtlMs ?? DEFAULT_ITEM_TTL_MS;
  }

  /**
   * Suspend unresolved write decisions while `turn/start`, `turn/steer`, or
   * goal ownership is ambiguous. Unconsumed permits are re-evaluated when the
   * matching token is released.
   */
  beginAmbiguity(): number {
    const token = this.nextAmbiguityToken++;
    this.ambiguityTokens.add(token);
    for (const item of this.itemsById.values()) {
      item.decision = null;
    }
    return token;
  }

  endAmbiguity(token: number): void {
    if (!this.ambiguityTokens.delete(token)) return;
    if (this.ambiguityTokens.size === 0) this.reconcile();
  }

  /** Re-evaluate every unresolved item after turn ownership changes. */
  reconcile(): void {
    if (this.ambiguityTokens.size > 0) return;
    for (const item of [...this.itemsById.values()]) {
      if (item.decision !== null) continue;
      const origin = this.resolveOrigin(item.turnId);
      if (!origin) continue;
      item.decision = this.evaluate(item.call, origin);
      this.settleItemIfReady(item);
    }
  }

  /** Consume app-server lifecycle notifications relevant to tool permits. */
  observe(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (method === "item/started") {
      this.observeItemStarted(params);
      return;
    }

    if (method === "item/completed") {
      const item = itemFromParams(params);
      const itemId = typeof item?.id === "string" ? item.id : null;
      if (itemId) {
        this.removeItem(
          itemId,
          "Codex tool item completed before authorization",
        );
      }
      return;
    }

    if (method === "turn/completed") {
      const turnId = turnIdFromParams(params);
      if (turnId) {
        for (const item of [...this.itemsById.values()]) {
          if (item.turnId !== turnId) continue;
          this.removeItem(
            item.itemId,
            "Codex turn completed before tool authorization",
          );
        }
      }
      return;
    }

    if (method === "turn/started") this.reconcile();
  }

  /**
   * Authorize one exact MCP conversation-tool invocation.
   *
   * The returned permit is consumed once. Missing item notifications, IPC
   * races, and unresolved turn ownership all resolve to `ok: false`.
   */
  authorize(call: CodexOutboundCall): Promise<CodexOutboundDecision> {
    const expectedSource = sourceForServer(call.server);
    if (expectedSource !== call.source || !GUARDED_TOOLS.has(call.tool)) {
      return Promise.resolve({
        ok: false,
        error: "invalid Compact Bot MCP tool identity",
      });
    }

    const key = codexOutboundCallFingerprint(call);
    return new Promise((resolve) => {
      const waiter: GuardWaiter = {
        key,
        resolve,
        item: null,
        settled: false,
        timeout: setTimeout(() => {
          this.timeoutWaiter(waiter);
        }, this.authorizationTimeoutMs),
      };
      waiter.timeout.unref();
      const queue = this.waitersByKey.get(key) ?? [];
      queue.push(waiter);
      this.waitersByKey.set(key, queue);
      this.pair(key);
    });
  }

  /** Deny all pending writes and invalidate all unconsumed permits. */
  clear(reason = "Codex outbound authorization state reset"): void {
    for (const item of [...this.itemsById.values()]) {
      this.removeItem(item.itemId, reason);
    }
    for (const queue of this.waitersByKey.values()) {
      for (const waiter of [...queue]) {
        this.settleWaiter(waiter, { ok: false, error: reason });
      }
    }
    this.waitersByKey.clear();
    this.ambiguityTokens.clear();
  }

  private observeItemStarted(params: Record<string, unknown>): void {
    const turnId = turnIdFromParams(params);
    const item = itemFromParams(params);
    if (!turnId || item?.type !== "mcpToolCall") return;

    const itemId = typeof item.id === "string" ? item.id : null;
    const source = sourceForServer(item.server);
    const tool = guardedTool(item.tool);
    const args =
      item.arguments && typeof item.arguments === "object" &&
        !Array.isArray(item.arguments)
        ? item.arguments as Record<string, unknown>
        : null;
    if (!itemId || !source || !tool || !args || this.itemsById.has(itemId)) {
      return;
    }

    const call: CodexOutboundCall = {
      source,
      server: String(item.server),
      tool,
      arguments: args,
    };
    const key = codexOutboundCallFingerprint(call);
    const origin =
      this.ambiguityTokens.size === 0 ? this.resolveOrigin(turnId) : null;
    const record: GuardItem = {
      itemId,
      turnId,
      key,
      call,
      decision: origin ? this.evaluate(call, origin) : null,
      waiter: null,
      timeout: setTimeout(() => {
        this.removeItem(itemId, "Codex tool authorization item expired");
      }, this.itemTtlMs),
    };
    record.timeout.unref();
    this.itemsById.set(itemId, record);
    const queue = this.itemsByKey.get(key) ?? [];
    queue.push(record);
    this.itemsByKey.set(key, queue);
    this.pair(key);
  }

  private evaluate(
    call: CodexOutboundCall,
    origin: IpcOrigin,
  ): CodexOutboundDecision {
    if (origin.source !== call.source) {
      return {
        ok: false,
        error: "Codex tool platform does not match the owning conversation",
      };
    }
    const targetChannel =
      call.tool === "fetch_messages"
        ? call.arguments.channel
        : call.arguments.chat_id;
    if (targetChannel !== origin.chat_id) {
      return {
        ok: false,
        error: "Codex tool channel does not match the owning conversation",
      };
    }
    if (
      call.source === "slack" &&
      (typeof call.arguments.thread_ts === "string"
        ? call.arguments.thread_ts
        : "") !== (origin.thread_ts ?? "")
    ) {
      return {
        ok: false,
        error: "Codex Slack reply thread does not match the owning conversation",
      };
    }
    return { ok: true };
  }

  private pair(key: string): void {
    const items = this.itemsByKey.get(key) ?? [];
    const waiters = this.waitersByKey.get(key) ?? [];
    for (const item of items) {
      if (item.waiter) continue;
      const waiter = waiters.shift();
      if (!waiter) break;
      item.waiter = waiter;
      waiter.item = item;
      this.settleItemIfReady(item);
    }
    if (waiters.length === 0) this.waitersByKey.delete(key);
    else this.waitersByKey.set(key, waiters);
  }

  private settleItemIfReady(item: GuardItem): void {
    if (!item.waiter || !item.decision) return;
    const { waiter, decision } = item;
    this.removeItemRecord(item);
    this.settleWaiter(waiter, decision);
  }

  private removeItem(itemId: string, reason: string): void {
    const item = this.itemsById.get(itemId);
    if (!item) return;
    const waiter = item.waiter;
    this.removeItemRecord(item);
    if (waiter) {
      this.settleWaiter(waiter, { ok: false, error: reason });
    }
  }

  private removeItemRecord(item: GuardItem): void {
    clearTimeout(item.timeout);
    this.itemsById.delete(item.itemId);
    const queue = this.itemsByKey.get(item.key);
    if (queue) {
      const index = queue.indexOf(item);
      if (index !== -1) queue.splice(index, 1);
      if (queue.length === 0) this.itemsByKey.delete(item.key);
    }
    if (item.waiter) item.waiter.item = null;
    item.waiter = null;
  }

  private timeoutWaiter(waiter: GuardWaiter): void {
    if (waiter.settled) return;
    if (waiter.item) {
      this.removeItemRecord(waiter.item);
    } else {
      const queue = this.waitersByKey.get(waiter.key);
      if (queue) {
        const index = queue.indexOf(waiter);
        if (index !== -1) queue.splice(index, 1);
        if (queue.length === 0) this.waitersByKey.delete(waiter.key);
      }
    }
    this.settleWaiter(waiter, {
      ok: false,
      error: "Codex outbound authorization timed out",
    });
  }

  private settleWaiter(
    waiter: GuardWaiter,
    decision: CodexOutboundDecision,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timeout);
    waiter.item = null;
    waiter.resolve(decision);
  }
}
