/**
 * Pure helpers for interpreting Slack Socket Mode message events.
 *
 * Keeping these decisions in a side-effect-free module lets them be unit
 * tested without booting the Slack Web/Socket clients.
 *
 * Exports:
 *   isProcessableSlackMessage, resolveSlackBlockActionContext.
 *
 * Example:
 *   >>> import { isProcessableSlackMessage } from "./slack-events.js";
 *   >>> isProcessableSlackMessage("file_share");
 *   true
 */

/** Slack message subtypes that still represent genuine user input. */
const USER_MESSAGE_SUBTYPES = new Set(["file_share"]);

/**
 * Decide whether a Slack `message` event should be handled as user input.
 *
 * Slack stamps many non-conversational events with a `subtype`
 * (``bot_message``, ``message_changed``, ``message_deleted``,
 * ``channel_join``, …); those must be skipped. The sole exception is
 * ``file_share``: Slack tags every file upload with this subtype, so
 * dropping all subtyped events would silently swallow attachments together
 * with any caption text the user typed.
 *
 * Args:
 *   subtype: The ``subtype`` field of the Slack message event, if present.
 *
 * Returns:
 *   True when the event carries genuine user content worth processing.
 */
export function isProcessableSlackMessage(subtype?: string): boolean {
  return !subtype || USER_MESSAGE_SUBTYPES.has(subtype);
}

export interface SlackBlockActionContext {
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  userId?: string;
  originalText: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve the stable location fields from a Slack ``block_actions`` payload.
 *
 * Slack marks top-level ``channel`` and ``message`` as optional, while the
 * required ``container`` carries canonical ``channel_id`` and ``message_ts``
 * values. Message fields are preferred when present and container fields keep
 * buttons working across DMs and other payload variants.
 */
export function resolveSlackBlockActionContext(
  value: unknown,
): SlackBlockActionContext {
  const body = record(value);
  const channel = record(body.channel);
  const message = record(body.message);
  const container = record(body.container);
  const user = record(body.user);
  return {
    channelId:
      optionalString(channel.id) ?? optionalString(container.channel_id),
    messageTs:
      optionalString(message.ts) ?? optionalString(container.message_ts),
    threadTs:
      optionalString(message.thread_ts) ??
      optionalString(container.thread_ts),
    userId: optionalString(user.id),
    originalText: optionalString(message.text) ?? "",
  };
}
