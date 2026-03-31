/**
 * Shared path constants for config and runtime data.
 *
 * Uses XDG Base Directory spec: defaults to ~/.config/compact-bot.
 * CWD .env is still supported and takes priority over the global one.
 *
 * Exports:
 *   CONFIG_HOME — user-global config directory (~/.config/compact-bot).
 *   DATA_DIR — runtime data directory (CONFIG_HOME/data).
 */

import { join } from "node:path";
import { homedir } from "node:os";

/** User-global config directory (XDG_CONFIG_HOME/compact-bot). */
export const CONFIG_HOME = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "compact-bot",
);

/** Runtime data directory for sockets, MCP config, attachments. */
export const DATA_DIR = join(CONFIG_HOME, "data");
