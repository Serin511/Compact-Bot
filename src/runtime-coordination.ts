/**
 * Small state machines shared by the wrapper and realtime platform adapters.
 *
 * Keeping these transitions side-effect free makes failover and authorization
 * races testable without booting Discord, Slack, or an agent process.
 */

import type { IpcOrigin } from "./ipc.js";

const PLATFORM_ONLY_ENV_KEYS = [
  "COMPACT_BOT_IPC_AUTH_TOKEN",
  "COMPACT_BOT_HOOK_IPC_AUTH_TOKEN",
  "COMPACT_BOT_WRAPPER_SOCKET",
  "WRAPPER_SOCKET",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
] as const;

function withoutPlatformCapabilities(
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(base).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of PLATFORM_ONLY_ENV_KEYS) delete env[key];
  return env;
}

/**
 * Build Claude Code's PTY environment without leaking platform capabilities.
 *
 * Claude itself needs the user's normal authentication environment. Platform
 * bot tokens and the mutable wrapper credential are consumed only by
 * wrapper-owned MCP children, so they must not be visible to model-spawned
 * shell commands. The hook receives a separate capability for a socket that
 * accepts only AskUserQuestion relay events.
 */
export function buildClaudePtyEnvironment(
  base: NodeJS.ProcessEnv,
  hookSocketPath: string,
  hookAuthToken: string,
): Record<string, string> {
  const env = withoutPlatformCapabilities(base);
  env.COMPACT_BOT_WRAPPER_SOCKET = hookSocketPath;
  env.COMPACT_BOT_HOOK_IPC_AUTH_TOKEN = hookAuthToken;
  return env;
}

/**
 * Build the Codex app-server environment without platform capabilities.
 *
 * App-server shell commands inherit this exact environment. Platform secrets
 * therefore live only in wrapper-owned MCP children reached through the
 * secretless stdio proxy.
 */
export function buildCodexAppServerEnvironment(
  base: NodeJS.ProcessEnv,
): Record<string, string> {
  return withoutPlatformCapabilities(base);
}

/**
 * Distinguish an intentionally retired startup from a genuine startup crash.
 *
 * A global "session changing" flag is not evidence that this exact backend
 * was replaced: non-replacing recovery controls can overlap a real startup
 * failure. A closing/resetting event or a concrete replacement generation is.
 */
export function isCodexStartupSuperseded<T>(
  backend: T,
  currentBackend: T | null,
  acceptsBackendEvents: boolean,
): boolean {
  return (
    !acceptsBackendEvents ||
    (currentBackend !== null && currentBackend !== backend)
  );
}

/** Tracks which exact realtime peers may still answer an active prompt. */
export class InputRecipientTracker<T> {
  private readonly pending: Set<T>;

  constructor(recipients: Iterable<T>) {
    this.pending = new Set(recipients);
  }

  get size(): number {
    return this.pending.size;
  }

  has(recipient: T): boolean {
    return this.pending.has(recipient);
  }

  /**
   * Resume waiting on a peer (or transfer the request to a replacement peer).
   *
   * Returns false when the peer was already eligible so a repeated `ready`
   * announcement cannot create duplicate delivery state.
   */
  add(recipient: T): boolean {
    const sizeBefore = this.pending.size;
    this.pending.add(recipient);
    return this.pending.size !== sizeBefore;
  }

  /**
   * Stop waiting on one peer.
   *
   * Returns false for duplicate failure/disconnect notifications so callers
   * cannot count one peer more than once.
   */
  remove(recipient: T): boolean {
    return this.pending.delete(recipient);
  }
}

interface RecentOrigin<TPeer> {
  origin: IpcOrigin;
  peer: TPeer;
  observedAt: number;
}

/**
 * Remembers a Claude channel origin only while its realtime peer is still
 * usable and the observation is recent enough to belong to the active work.
 */
export class RecentOriginTracker<TPeer> {
  private currentValue: RecentOrigin<TPeer> | null = null;

  constructor(private readonly maxAgeMs: number) {}

  remember(origin: IpcOrigin, peer: TPeer, now = Date.now()): void {
    this.currentValue = { origin, peer, observedAt: now };
  }

  current(
    isPeerReady: (peer: TPeer, origin: IpcOrigin) => boolean,
    now = Date.now(),
  ): IpcOrigin | null {
    const value = this.currentValue;
    if (
      !value ||
      now - value.observedAt > this.maxAgeMs ||
      !isPeerReady(value.peer, value.origin)
    ) {
      this.currentValue = null;
      return null;
    }
    return value.origin;
  }

  forgetPeer(peer: TPeer): void {
    if (this.currentValue?.peer === peer) this.currentValue = null;
  }
}

/**
 * Atomically claim a pending item before the first await in an event handler.
 */
export function takePendingValue<T>(
  pending: Map<string, T>,
  key: string,
): T | undefined {
  const value = pending.get(key);
  if (value === undefined) return undefined;
  pending.delete(key);
  return value;
}

/**
 * Restore a claimed pending item after a transient delivery failure.
 *
 * Never overwrite a newer item that reused the same correlation ID while the
 * original async delivery attempt was in flight.
 */
export function restorePendingValueIfAbsent<T>(
  pending: Map<string, T>,
  key: string,
  value: T,
): boolean {
  if (pending.has(key)) return false;
  pending.set(key, value);
  return true;
}

/**
 * Convert an async notification send into an explicit delivery result.
 *
 * Permission UIs must only show an allow/deny decision after the host has
 * actually accepted the verdict.
 */
export async function attemptNotificationDelivery(
  deliver: () => void | Promise<void>,
  onError?: (error: unknown) => void,
): Promise<boolean> {
  try {
    await deliver();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

/** Codex channel ingress has no stdio fallback when wrapper IPC is unavailable. */
export function requiresWrapperIpc(
  provider: "claude" | "codex",
): boolean {
  return provider === "codex";
}

/** Socket Mode states in which interactive events cannot be received. */
export function isRealtimeUnavailableLifecycle(
  state: string,
): boolean {
  return (
    state === "reconnecting" ||
    state === "disconnecting" ||
    state === "disconnected"
  );
}

/**
 * Preserve exclusive realtime ownership until disconnect has completed.
 *
 * If disconnect rejects, release is intentionally not called. The caller
 * should exit and let the OS tear down both resources together.
 */
export async function disconnectThenRelease(
  disconnect: () => void | Promise<void>,
  release: () => void,
): Promise<void> {
  await disconnect();
  release();
}
