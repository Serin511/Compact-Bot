/**
 * Sanitization and path-safety helpers shared by both MCP servers.
 *
 * Exports:
 *   safeAttName — strip delimiter characters from user-supplied attachment names.
 *   isSendablePath — reject paths that point into server-private state.
 *
 * Example:
 *   >>> safeAttName("evil\nname]hack");
 *   "evil_name_hack"
 */

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { CONFIG_HOME, DATA_DIR } from "./paths.js";

const ATTACHMENTS_DIR = `${DATA_DIR}${sep}attachments`;

/**
 * Strip characters that would let an uploader forge new rows in the
 * channel-notification meta or in tool-result text.
 *
 * The attachment name is uploader-controlled and lands inside text frames
 * that use ``[name]`` annotations, ``;`` separators, and newline-joined
 * listings. Replacing those characters with ``_`` keeps the value visible
 * but eliminates its ability to break out of the surrounding frame.
 *
 * Args:
 *   name: Original filename (may be null/empty).
 *   fallback: Value to use when ``name`` is null or empty.
 *
 * Returns:
 *   Sanitized name, or ``fallback`` when no usable name was given.
 */
export function safeAttName(name: string | null | undefined, fallback = "file"): string {
  const src = (name ?? "").trim();
  if (!src) return fallback;
  return src.replace(/[\[\]\r\n;]/g, "_");
}

/**
 * Decide whether a file path is safe to surface back through the chat —
 * i.e. it does NOT point into ``CONFIG_HOME`` outside the attachments
 * inbox.
 *
 * The reply tool's ``files`` argument is model-controlled. Without this
 * guard, a prompt-injected message could ask the assistant to send the
 * server's own ``.env``, IPC socket, or session log back as a Discord /
 * Slack attachment, exfiltrating credentials.
 *
 * Args:
 *   path: Absolute path the model wants to attach.
 *
 * Returns:
 *   true if the path lives outside ``CONFIG_HOME`` or inside the
 *   downloaded-attachments inbox; false when it lands in any other
 *   server-private location.
 */
export function isSendablePath(path: string): boolean {
  let real: string;
  let configReal: string;
  let attachmentsReal: string;
  try {
    real = realpathSync(path);
  } catch {
    // Non-existent path — let the downstream send error report it.
    return true;
  }
  try {
    configReal = realpathSync(CONFIG_HOME);
  } catch {
    // CONFIG_HOME missing → nothing private to leak.
    return true;
  }
  try {
    attachmentsReal = realpathSync(ATTACHMENTS_DIR);
  } catch {
    attachmentsReal = ATTACHMENTS_DIR; // not yet created — treat literal path as authoritative
  }

  const inConfig =
    real === configReal || real.startsWith(configReal + sep);
  if (!inConfig) return true;
  return real === attachmentsReal || real.startsWith(attachmentsReal + sep);
}
