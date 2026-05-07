/**
 * PreToolUse hook for the AskUserQuestion built-in tool.
 *
 * Claude Code 2.1.132+ re-enabled `AskUserQuestion` in Channels mode but
 * does not surface the call over the MCP transport — the Ink widget just
 * renders to the PTY. This hook is wired in via ``--settings`` so it fires
 * the moment Claude Code is about to invoke AskUserQuestion. It hands the
 * structured tool input (questions, options, descriptions, previews) to
 * the wrapper over the existing IPC socket and exits, letting the tool
 * proceed normally. The wrapper then formats the question for Discord /
 * Slack and drives the user's response back into the Ink widget via PTY
 * keystrokes (see ``handleInputResponse`` in ``src/wrapper.ts``).
 *
 * Standard hook contract:
 *   - Reads a JSON event from stdin: `{ tool_name, tool_input, ... }`.
 *   - Writes the hook decision JSON to stdout. Empty `{}` means "allow
 *     and continue", which is what we always emit.
 *
 * Exit code is always 0 — a non-zero exit would block AskUserQuestion
 * even if the IPC forward failed, leaving the user with a hung session.
 *
 * Exports:
 *   None (side-effect: a `node ./hook-runner.js` invocation per AskUserQuestion call).
 */

import { createConnection } from "node:net";

const SOCKET_PATH = process.env.COMPACT_BOT_WRAPPER_SOCKET || "";
/** Hard upper bound on how long we'll wait for the IPC handoff to complete. */
const FORWARD_TIMEOUT_MS = 2000;

type HookEvent = {
  tool_name?: string;
  tool_input?: unknown;
};

async function readStdinAsJson(): Promise<HookEvent | null> {
  return await new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => {
      if (!buf.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(buf) as HookEvent);
      } catch {
        resolve(null);
      }
    });
    process.stdin.on("error", () => resolve(null));
  });
}

function forwardToWrapper(toolInput: unknown): Promise<void> {
  return new Promise((resolve) => {
    if (!SOCKET_PATH) {
      resolve();
      return;
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const sock = createConnection(SOCKET_PATH);
    const timeout = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      finish();
    }, FORWARD_TIMEOUT_MS);

    sock.on("connect", () => {
      const payload =
        JSON.stringify({ type: "pre_ask_user_question", tool_input: toolInput }) + "\n";
      sock.write(payload, () => {
        // Give the kernel a moment to flush before we close — some socket
        // implementations drop unflushed bytes when the writer ends abruptly.
        sock.end();
      });
    });
    sock.on("close", () => {
      clearTimeout(timeout);
      finish();
    });
    sock.on("error", () => {
      clearTimeout(timeout);
      finish();
    });
  });
}

async function main(): Promise<void> {
  const event = await readStdinAsJson();
  if (event && event.tool_name === "AskUserQuestion" && event.tool_input) {
    await forwardToWrapper(event.tool_input);
  }
  // Empty object = no decision, default behaviour (allow). We never block.
  process.stdout.write("{}");
}

main()
  .catch(() => {
    // Swallow — never fail the tool call because of a hook glitch.
    process.stdout.write("{}");
  })
  .finally(() => process.exit(0));
