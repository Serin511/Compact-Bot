/**
 * Shared chat-side authorization helpers.
 *
 * Empty operator lists preserve the historical trusted-channel behaviour.
 * Deployments with more than one trusted human should set explicit operator
 * IDs so state-changing commands and host permission decisions cannot be
 * triggered by every member of an allowlisted channel.
 */

import type { RouteType } from "./message-router.js";

/**
 * Return whether a user may perform operator-only actions.
 *
 * An empty allowlist is intentionally permissive for backwards compatibility;
 * setup and documentation warn operators to configure IDs for shared channels.
 */
export function isOperator(
  userId: string | null | undefined,
  operatorUserIds: readonly string[],
): boolean {
  if (operatorUserIds.length === 0) return true;
  return typeof userId === "string" && operatorUserIds.includes(userId);
}

/**
 * Return whether a platform channel is inside the configured routing boundary.
 *
 * An empty allowlist intentionally means every channel the bot can access,
 * matching the existing inbound-message behaviour.
 */
export function isAllowedChannel(
  channelId: string,
  allowedChannelIds: readonly string[],
): boolean {
  return (
    allowedChannelIds.length === 0 ||
    allowedChannelIds.includes(channelId)
  );
}

/** Commands that can mutate or disclose the shared local agent session. */
export function isPrivilegedCommand(type: RouteType): boolean {
  return type !== "message" && type !== "help";
}
