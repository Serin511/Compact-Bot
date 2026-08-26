/**
 * Platform-neutral state machine for bounded permission prompts.
 *
 * Entries are claimed before an async manual verdict is delivered. A failed
 * delivery may restore the claim, but always with its original deadline.
 */

export interface ExpiringPermissionClaim<TPermission> {
  readonly requestId: string;
  readonly permission: TPermission;
  readonly expiresAt: number;
}

interface ExpiringPermissionEntry<TPermission>
  extends ExpiringPermissionClaim<TPermission> {
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ExpiringPermissionsOptions<TPermission> {
  ttlMs: number;
  sendDeny: (requestId: string) => Promise<boolean>;
  updateExpiredPrompt: (
    claim: ExpiringPermissionClaim<TPermission>,
    delivered: boolean,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export class ExpiringPermissions<TPermission> {
  private readonly entries =
    new Map<string, ExpiringPermissionEntry<TPermission>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly options: ExpiringPermissionsOptions<TPermission>,
  ) {
    this.ttlMs = options.ttlMs;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error(`permission ttl must be positive, got ${this.ttlMs}`);
    }
    this.now = options.now ?? Date.now;
  }

  set(requestId: string, permission: TPermission): void {
    this.delete(requestId);
    const entry: ExpiringPermissionEntry<TPermission> = {
      requestId,
      permission,
      expiresAt: this.now() + this.ttlMs,
      timer: null,
    };
    this.entries.set(requestId, entry);
    this.schedule(entry);
  }

  get(requestId: string): TPermission | undefined {
    return this.entries.get(requestId)?.permission;
  }

  has(requestId: string): boolean {
    return this.entries.has(requestId);
  }

  take(
    requestId: string,
  ): ExpiringPermissionClaim<TPermission> | undefined {
    const entry = this.entries.get(requestId);
    if (!entry) return undefined;
    this.entries.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    return {
      requestId: entry.requestId,
      permission: entry.permission,
      expiresAt: entry.expiresAt,
    };
  }

  restore(claim: ExpiringPermissionClaim<TPermission>): boolean {
    if (this.entries.has(claim.requestId)) return false;
    const entry: ExpiringPermissionEntry<TPermission> = {
      ...claim,
      timer: null,
    };
    this.entries.set(claim.requestId, entry);
    this.schedule(entry);
    return true;
  }

  delete(requestId: string): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.entries.delete(requestId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    return true;
  }

  dispose(): void {
    for (const requestId of this.entries.keys()) this.delete(requestId);
  }

  private schedule(entry: ExpiringPermissionEntry<TPermission>): void {
    const delay = Math.max(0, entry.expiresAt - this.now());
    entry.timer = setTimeout(() => {
      if (this.entries.get(entry.requestId) !== entry) return;
      this.entries.delete(entry.requestId);
      entry.timer = null;
      void this.expire(entry);
    }, delay);
    entry.timer.unref?.();
  }

  private async expire(
    entry: ExpiringPermissionEntry<TPermission>,
  ): Promise<void> {
    let delivered = false;
    try {
      delivered = await this.options.sendDeny(entry.requestId);
    } catch (error) {
      this.options.onError?.(error);
    }

    try {
      await this.options.updateExpiredPrompt(
        {
          requestId: entry.requestId,
          permission: entry.permission,
          expiresAt: entry.expiresAt,
        },
        delivered,
      );
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
