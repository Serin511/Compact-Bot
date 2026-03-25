/**
 * Session CRUD and channel-to-session mapping with file persistence.
 *
 * Exports:
 *   SessionManager, SessionState.
 *
 * Example:
 *   >>> const mgr = new SessionManager();
 *   >>> const session = mgr.get("channel-123");
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

export interface SessionState {
  sessionId: string;
  cwd: string;
  model: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  lastActivity: string;
  isProcessing: boolean;
  conversationSummary?: string;
}

interface SessionsFileV2 {
  version: 2;
  active: Record<string, SessionState>;
  history: Record<string, SessionState[]>;
}

const SESSIONS_PATH = join(process.cwd(), "data", "sessions.json");
const MAX_HISTORY = 20;

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private history: Map<string, SessionState[]> = new Map();

  constructor() {
    this.load();
  }

  /**
   * Load sessions from the persistence file, migrating v1 format if needed.
   */
  private load(): void {
    if (!existsSync(SESSIONS_PATH)) return;
    try {
      const raw = readFileSync(SESSIONS_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, unknown>;

      if (data.version === 2) {
        // V2 format
        const v2 = data as unknown as SessionsFileV2;
        for (const [channelId, session] of Object.entries(v2.active)) {
          this.sessions.set(channelId, session);
        }
        for (const [channelId, hist] of Object.entries(v2.history)) {
          this.history.set(channelId, hist);
        }
      } else {
        // V1 legacy format: { channelId: SessionState }
        for (const [channelId, session] of Object.entries(data)) {
          this.sessions.set(channelId, session as SessionState);
        }
      }
    } catch {
      // Start fresh on parse error
    }
  }

  /**
   * Persist all sessions to disk in v2 format.
   */
  save(): void {
    const dir = dirname(SESSIONS_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: SessionsFileV2 = {
      version: 2,
      active: Object.fromEntries(this.sessions),
      history: Object.fromEntries(this.history),
    };
    writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2));
  }

  /**
   * Get session for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   SessionState or undefined if no session exists.
   */
  get(channelId: string): SessionState | undefined {
    return this.sessions.get(channelId);
  }

  /**
   * Create a new session for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *   sessionId: Claude CLI session UUID.
   *   cwd: Working directory.
   *   model: Model identifier.
   *
   * Returns:
   *   The newly created SessionState.
   */
  create(
    channelId: string,
    sessionId: string,
    cwd?: string,
    model?: string,
  ): SessionState {
    const session: SessionState = {
      sessionId,
      cwd: cwd ?? config.defaultCwd,
      model: model ?? config.defaultModel,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      turnCount: 0,
      lastActivity: new Date().toISOString(),
      isProcessing: false,
    };
    this.sessions.set(channelId, session);
    this.save();
    return session;
  }

  /**
   * Update an existing session with partial fields.
   *
   * Args:
   *   channelId: Discord channel ID.
   *   updates: Partial session fields to merge.
   */
  update(channelId: string, updates: Partial<SessionState>): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    Object.assign(session, updates);
    this.save();
  }

  /**
   * Archive the active session to history and clear it.
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   True if a session was archived, false if none existed.
   */
  archive(channelId: string): boolean {
    const session = this.sessions.get(channelId);
    if (!session) return false;

    const hist = this.history.get(channelId) ?? [];
    hist.push({ ...session, isProcessing: false });
    if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
    this.history.set(channelId, hist);
    this.sessions.delete(channelId);
    this.save();
    return true;
  }

  /**
   * Get session history for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   Array of past sessions, oldest first.
   */
  getHistory(channelId: string): SessionState[] {
    return this.history.get(channelId) ?? [];
  }

  /**
   * Restore a session from history by session ID prefix.
   *
   * Archives the current active session before restoring.
   *
   * Args:
   *   channelId: Discord channel ID.
   *   sessionIdPrefix: Prefix of the session ID to restore.
   *
   * Returns:
   *   The restored SessionState, or undefined if not found.
   */
  restore(channelId: string, sessionIdPrefix: string): SessionState | undefined {
    const hist = this.history.get(channelId) ?? [];
    const idx = hist.findIndex((s) =>
      s.sessionId.startsWith(sessionIdPrefix),
    );
    if (idx === -1) return undefined;

    // Archive current active session first
    const current = this.sessions.get(channelId);
    if (current) {
      hist.push({ ...current, isProcessing: false });
      if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
    }

    // Remove from history and set as active
    const [restored] = hist.splice(idx, 1);
    this.sessions.set(channelId, restored);
    this.history.set(channelId, hist);
    this.save();
    return restored;
  }

  /**
   * Delete a session.
   *
   * Args:
   *   channelId: Discord channel ID.
   */
  delete(channelId: string): void {
    this.sessions.delete(channelId);
    this.save();
  }

  /**
   * Add token usage to a session's running totals.
   *
   * Args:
   *   channelId: Discord channel ID.
   *   inputTokens: Input tokens used in this turn.
   *   outputTokens: Output tokens used in this turn.
   */
  addUsage(
    channelId: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.totalInputTokens += inputTokens;
    session.totalOutputTokens += outputTokens;
    session.turnCount += 1;
    session.lastActivity = new Date().toISOString();
    this.save();
  }

  /**
   * Check if the given channel is allowed (if restrictions are configured).
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   True if the channel is allowed or no restrictions are configured.
   */
  isChannelAllowed(channelId: string): boolean {
    if (config.allowedChannelIds.length === 0) return true;
    return config.allowedChannelIds.includes(channelId);
  }
}
