/**
 * Pure helpers for interpreting Slack Socket Mode message events.
 *
 * Keeping these decisions in a side-effect-free module lets them be unit
 * tested without booting the Slack Web/Socket clients.
 *
 * Exports:
 *   isProcessableSlackMessage.
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
