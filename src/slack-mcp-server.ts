/**
 * MCP Channel server bridging Slack and Claude Code.
 *
 * Spawned by Claude Code as a subprocess. Communicates with Claude via
 * the MCP stdio transport (channel notifications + tool calls) and with
 * the wrapper via a Unix domain socket for lifecycle control.
 *
 * Uses Socket Mode (WebSocket) for receiving Slack events and
 * the Web API for sending messages, reactions, and file uploads.
 *
 * Exports:
 *   None (side-effect: starts MCP server, connects to Slack and wrapper).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import {
  connectToWrapper,
  type McpToWrapper,
  type WrapperToMcp,
  type JsonLineSocket,
} from "./ipc.js";
import { routeMessage } from "./message-router.js";
import {
  downloadSlackAttachments,
  type SlackFile,
} from "./slack-attachment-handler.js";
import { msg } from "./messages.js";

// ── env (injected by wrapper via mcp-config.json) ─────────────────────

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN!;
const WRAPPER_SOCKET = process.env.WRAPPER_SOCKET!;
const ALLOWED_CHANNEL_IDS = (process.env.SLACK_ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FETCH_MESSAGE_LIMIT = Number(process.env.FETCH_MESSAGE_LIMIT || "20");

// ── state ─────────────────────────────────────────────────────────────

let ipc: JsonLineSocket | null = null;
let currentModel = "";
let currentCwd = "";
let botUserId = "";

/**
 * Request a screen capture from the wrapper via IPC.
 *
 * Returns:
 *   The captured screen text, or null on timeout / no connection.
 */
function requestCapture(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!ipc) {
      resolve(null);
      return;
    }
    const timeout = setTimeout(() => resolve(null), 5000);
    const handler = (msg: WrapperToMcp) => {
      if (msg.type === "capture_result") {
        clearTimeout(timeout);
        ipc?.removeListener("message", handler);
        resolve(msg.text);
      }
    };
    ipc.on("message", handler);
    ipc.send({ type: "capture" } satisfies McpToWrapper);
  });
}

function isAllowed(channelId: string): boolean {
  if (ALLOWED_CHANNEL_IDS.length === 0) return true;
  return ALLOWED_CHANNEL_IDS.includes(channelId);
}

/** Log to stderr (stdout is reserved for MCP protocol). */
function stderr(msg: string): void {
  process.stderr.write(`[slack-mcp] ${msg}\n`);
}

// ── Slack clients ────────────────────────────────────────────────────

const web = new WebClient(SLACK_BOT_TOKEN);
const socketMode = new SocketModeClient({ appToken: SLACK_APP_TOKEN });

// ── user display name cache ──────────────────────────────────────────

const userNameCache = new Map<string, string>();

async function getUserDisplayName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const result = await web.users.info({ user: userId });
    const name =
      result.user?.profile?.display_name ||
      result.user?.real_name ||
      result.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ── MCP server ────────────────────────────────────────────────────────

const mcp = new McpServer(
  { name: "slack-bot", version: "0.1.0" },
  {
    capabilities: {
      tools: {},
      experimental: { "claude/channel": {} },
    },
    instructions: [
      "The sender reads Slack, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.",
      "",
      'Messages from Slack arrive as <channel source="slack" chat_id="..." message_id="..." user="..." ts="...">.',
      "If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(chat_id, message_id) to fetch them.",
      "Reply with the reply tool — pass chat_id back.",
      "Use thread_ts to reply in a thread; omit it for top-level responses.",
      "",
      "reply accepts file paths (files: ['/abs/path.png']) for attachments.",
      "Use react to add emoji reactions (name only, no colons — e.g. 'thumbsup' not ':thumbsup:').",
      "Use edit_message for interim progress updates.",
      "Edits don't trigger push notifications — when a long task completes, send a new reply so the user's device pings.",
      "",
      "fetch_messages pulls real Slack channel history.",
      "",
      "Use Slack mrkdwn formatting: *bold*, _italic_, `code`, ```code block```, ~strikethrough~.",
      "Do NOT use Discord-style formatting (**bold**, __underline__).",
      "",
      "All user-facing messages should be in Korean.",
    ].join("\n"),
  },
);

// ── message splitting (Slack 4000 char limit) ──────────────────────

function splitMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

// ── MCP tools ─────────────────────────────────────────────────────────

mcp.tool(
  "reply",
  "Reply on Slack. Pass chat_id from the inbound message. Optionally pass thread_ts for threading, and files (absolute paths) to attach.",
  {
    chat_id: z.string().describe("Slack channel ID"),
    text: z.string().describe("Message text (Slack mrkdwn format)"),
    thread_ts: z
      .string()
      .optional()
      .describe("Thread timestamp to reply in a thread. Use thread_ts from the inbound <channel> block for threaded replies."),
    files: z
      .array(z.string())
      .optional()
      .describe("Absolute file paths to attach (images, logs, etc). Max 10 files."),
  },
  async ({ chat_id, text, thread_ts, files }) => {
    const chunks = splitMessage(text);
    const sentTimestamps: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const result = await web.chat.postMessage({
        channel: chat_id,
        text: chunks[i],
        ...(thread_ts ? { thread_ts } : {}),
      });
      if (result.ts) sentTimestamps.push(result.ts);

      // Use first message's ts as thread_ts for subsequent chunks
      if (i === 0 && result.ts && !thread_ts) {
        thread_ts = result.ts;
      }
    }

    // Upload files if provided
    if (files?.length) {
      try {
        await web.filesUploadV2({
          channel_id: chat_id,
          thread_ts,
          file_uploads: files.map((f) => ({
            file: f,
            filename: f.split("/").pop() ?? "file",
          })),
        });
      } catch (err) {
        stderr(`File upload failed: ${err}`);
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Sent ${sentTimestamps.length} message(s): ${sentTimestamps.join(", ")}`,
        },
      ],
    };
  },
);

mcp.tool(
  "react",
  "Add an emoji reaction to a Slack message. Use emoji names without colons (e.g. 'thumbsup', not ':thumbsup:').",
  {
    chat_id: z.string().describe("Slack channel ID"),
    message_id: z.string().describe("Message timestamp"),
    emoji: z.string().describe("Emoji name without colons (e.g. 'thumbsup')"),
  },
  async ({ chat_id, message_id, emoji }) => {
    const name = emoji.replace(/^:|:$/g, "");
    await web.reactions.add({
      channel: chat_id,
      timestamp: message_id,
      name,
    });
    return { content: [{ type: "text" as const, text: "Reaction added" }] };
  },
);

mcp.tool(
  "edit_message",
  "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
  {
    chat_id: z.string().describe("Slack channel ID"),
    message_id: z.string().describe("Message timestamp to edit"),
    text: z.string().describe("New message text (Slack mrkdwn format)"),
  },
  async ({ chat_id, message_id, text }) => {
    await web.chat.update({
      channel: chat_id,
      ts: message_id,
      text,
    });
    return { content: [{ type: "text" as const, text: "Message edited" }] };
  },
);

mcp.tool(
  "fetch_messages",
  "Fetch recent messages from a Slack channel. Returns oldest-first with message timestamps as IDs. Supports pagination for more than 100 messages (0 for max).",
  {
    channel: z.string().describe("Slack channel ID"),
    limit: z
      .number()
      .optional()
      .default(FETCH_MESSAGE_LIMIT)
      .describe(`Max messages to fetch (default ${FETCH_MESSAGE_LIMIT}, 0 for max 500). Paginates automatically above 100.`),
  },
  async ({ channel: channelId, limit }) => {
    const target = limit === 0 ? 500 : limit;
    const allMessages: Array<{ ts: string; user?: string; text?: string; files?: unknown[] }> = [];
    let cursor: string | undefined;

    while (allMessages.length < target) {
      const result = await web.conversations.history({
        channel: channelId,
        limit: Math.min(target - allMessages.length, 100),
        ...(cursor ? { cursor } : {}),
      });
      if (!result.messages || result.messages.length === 0) break;
      allMessages.push(...(result.messages as typeof allMessages));
      cursor = result.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    const lines = await Promise.all(
      allMessages.reverse().map(async (m) => {
        const author = m.user
          ? m.user === botUserId
            ? "BOT"
            : await getUserDisplayName(m.user)
          : "unknown";
        const att = m.files && (m.files as unknown[]).length > 0
          ? ` +${(m.files as unknown[]).length}att`
          : "";
        return `[${m.ts}] ${author}: ${(m.text ?? "").slice(0, 200)}${att}`;
      }),
    );

    return {
      content: [{ type: "text" as const, text: lines.join("\n") || "(empty)" }],
    };
  },
);

mcp.tool(
  "download_attachment",
  "Download attachments from a specific Slack message. Returns file paths ready to Read.",
  {
    chat_id: z.string().describe("Slack channel ID"),
    message_id: z.string().describe("Message timestamp with attachments"),
  },
  async ({ chat_id, message_id }) => {
    const result = await web.conversations.history({
      channel: chat_id,
      latest: message_id,
      inclusive: true,
      limit: 1,
    });

    const message = result.messages?.[0];
    if (!message?.files || message.files.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No attachments found" }],
      };
    }

    const { promptPrefix } = await downloadSlackAttachments(
      message.files as SlackFile[],
      message_id,
      SLACK_BOT_TOKEN,
    );

    return {
      content: [
        { type: "text" as const, text: promptPrefix || "Attachments downloaded" },
      ],
    };
  },
);

// ── Slack message handler ────────────────────────────────────────────

async function sendChannelNotification(
  content: string,
  meta: Record<string, string>,
): Promise<void> {
  await mcp.server.notification({
    method: "notifications/claude/channel",
    params: { content, meta },
  });
}

async function handleSlackMessage(event: {
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  channel_type?: string;
}): Promise<void> {
  // Ignore bot's own messages
  if (event.user === botUserId) return;
  if (!event.user) return;
  if (!isAllowed(event.channel)) return;

  const route = routeMessage(event.text ?? "");
  const displayName = await getUserDisplayName(event.user);

  // Helper to reply in the same thread or channel
  const replyText = async (text: string): Promise<void> => {
    await web.chat.postMessage({
      channel: event.channel,
      text,
      ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
    });
  };

  switch (route.type) {
    case "new":
      await replyText(msg("newSession"));
      ipc?.send({ type: "restart", reason: "new" } satisfies McpToWrapper);
      return;

    case "clear":
      await replyText(msg("clearSession"));
      ipc?.send({ type: "clear" } satisfies McpToWrapper);
      return;

    case "compact":
      await replyText(msg("compacting"));
      ipc?.send({
        type: "compact",
        ...(route.args ? { hint: route.args } : {}),
      } satisfies McpToWrapper);
      return;

    case "model": {
      if (!route.args) {
        await replyText(msg("modelCurrent", { model: currentModel || "(CLI default)" }));
        return;
      }
      const modelMap: Record<string, string> = {
        sonnet: "claude-sonnet-4-6",
        opus: "claude-opus-4-6",
        haiku: "claude-haiku-4-5-20251001",
      };
      const resolved = modelMap[route.args] ?? route.args;
      await replyText(msg("modelChanged", { model: resolved }));
      ipc?.send({ type: "model", model: resolved } satisfies McpToWrapper);
      return;
    }

    case "cwd": {
      if (!route.args) {
        await replyText(msg("cwdCurrent", { cwd: currentCwd }));
        return;
      }
      await replyText(msg("cwdChanged", { path: route.args }));
      ipc?.send({ type: "cwd", cwd: route.args } satisfies McpToWrapper);
      return;
    }

    case "capture": {
      await replyText(msg("captureRequested"));
      const screen = await requestCapture();
      if (!screen) {
        await replyText(msg("captureEmpty"));
        return;
      }
      const chunks = splitMessage(`\`\`\`\n${screen}\n\`\`\``);
      for (const chunk of chunks) {
        await web.chat.postMessage({
          channel: event.channel,
          text: chunk,
          ...(event.thread_ts ? { thread_ts: event.thread_ts } : {}),
        });
      }
      return;
    }

    case "help":
      await replyText(msg("help"));
      return;

    default: {
      // Regular message → channel notification
      let content = event.text ?? "";

      const meta: Record<string, string> = {
        chat_id: event.channel,
        message_id: event.ts,
        user: displayName,
        ts: event.ts,
      };

      if (event.thread_ts) {
        meta.thread_ts = event.thread_ts;
      }

      if (event.files && event.files.length > 0) {
        meta.attachment_count = String(event.files.length);
        meta.attachments = event.files
          .map(
            (f) =>
              `${f.name ?? "unknown"} (${f.mimetype ?? "unknown"}, ${f.size} bytes)`,
          )
          .join("; ");
      }

      await sendChannelNotification(content, meta);
    }
  }
}

// ── Socket Mode event handling ───────────────────────────────────────

socketMode.on("message", async ({ event, ack }) => {
  await ack();

  // Only handle regular messages (no subtypes like bot_message, message_changed, etc.)
  if (event.subtype) return;

  handleSlackMessage(event).catch((err) => {
    stderr(`Message handler error: ${err}`);
  });
});

socketMode.on("connected", () => {
  stderr("Slack Socket Mode connected");
});

// ── startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Connect IPC to wrapper
  try {
    ipc = await connectToWrapper(WRAPPER_SOCKET);
    ipc.on("message", (msg: WrapperToMcp) => {
      if (msg.type === "config") {
        currentModel = msg.model;
        currentCwd = msg.cwd;
        stderr(`Config received: model=${msg.model} cwd=${msg.cwd}`);
      }
    });
    ipc.on("close", () => {
      stderr("Wrapper IPC disconnected");
      ipc = null;
    });
    ipc.send({ type: "ready" } satisfies McpToWrapper);
  } catch (err) {
    stderr(`IPC connect failed: ${err}`);
  }

  // Get bot user ID for self-message filtering
  try {
    const authResult = await web.auth.test();
    botUserId = authResult.user_id ?? "";
    stderr(`Slack authenticated as ${authResult.user} (${botUserId})`);
  } catch (err) {
    stderr(`Slack auth.test failed: ${err}`);
  }

  // Connect Slack Socket Mode
  await socketMode.start();

  // Start MCP stdio transport (must be last — blocks on stdio)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}

main().catch((err) => {
  stderr(`Fatal: ${err}`);
  process.exit(1);
});
