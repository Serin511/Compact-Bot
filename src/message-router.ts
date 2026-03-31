/**
 * Command classification and routing for incoming chat messages.
 *
 * Exports:
 *   routeMessage, RouteResult, RouteType.
 *
 * Example:
 *   >>> const route = routeMessage("/compact focus on API");
 *   >>> // { type: "compact", args: "focus on API" }
 */

export type RouteType =
  | "compact"
  | "clear"
  | "model"
  | "cwd"
  | "help"
  | "new"
  | "capture"
  | "message";

export interface RouteResult {
  type: RouteType;
  args?: string;
}

const COMMAND_MAP: Record<string, RouteType> = {
  "/compact": "compact",
  "/clear": "clear",
  "/model": "model",
  "/cwd": "cwd",
  "/help": "help",
  "/new": "new",
  "/capture": "capture",
};

/**
 * Classify an incoming message as a command or regular message.
 *
 * Args:
 *   content: Raw message text from Discord.
 *
 * Returns:
 *   RouteResult indicating the command type and any arguments.
 */
export function routeMessage(content: string): RouteResult {
  const trimmed = content.trim();

  for (const [prefix, type] of Object.entries(COMMAND_MAP)) {
    if (trimmed === prefix) {
      return { type };
    }
    if (trimmed.startsWith(prefix + " ")) {
      return { type, args: trimmed.slice(prefix.length + 1).trim() };
    }
  }

  return { type: "message", args: trimmed };
}
