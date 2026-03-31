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
let lastActiveChannelId: string | null = null;
let lastActiveThreadTs: string | undefined = undefined;

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
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
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

// ── MCP permission request handler ──────────────────────────────────

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.server.setNotificationHandler(
  PermissionRequestSchema,
  async (notification) => {
    handlePermissionRequest(notification.params).catch((err) => {
      stderr(`Permission request handler error: ${err}`);
    });
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

// ── permission prompt handling (MCP Channel protocol) ───────────────

/**
 * Extract a JSON string value by key using regex.
 *
 * Works on truncated/incomplete JSON where JSON.parse would fail.
 * If the value is truncated (no closing quote), captures until end of string.
 */
function extractJsonField(text: string, key: string): string | null {
  const complete = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const cm = text.match(complete);
  if (cm) return cm[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "\t");

  const truncated = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`);
  const tm = text.match(truncated);
  if (tm) return tm[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, "\t") + "…";

  return null;
}

/**
 * Format tool input preview for Slack mrkdwn display.
 *
 * Handles both complete and truncated JSON from Claude Code's
 * input_preview field by extracting fields via regex.
 */
function formatPreview(
  toolName: string,
  inputPreview: string,
  description: string,
): string {
  if (!inputPreview && !description) return "(상세 정보 없음)";

  const src = inputPreview || description;
  const lines: string[] = [];

  switch (toolName) {
    case "Bash": {
      const cmd = extractJsonField(src, "command");
      const desc = extractJsonField(src, "description");
      if (cmd) lines.push(`\`\`\`${cmd}\`\`\``);
      if (desc) lines.push(`> ${desc}`);
      break;
    }
    case "Edit": {
      const fp = extractJsonField(src, "file_path");
      const old = extractJsonField(src, "old_string");
      const nw = extractJsonField(src, "new_string");
      if (fp) lines.push(`:page_facing_up: \`${fp}\``);
      if (old) lines.push(`\`\`\`- ${old}\`\`\``);
      if (nw) lines.push(`\`\`\`+ ${nw}\`\`\``);
      break;
    }
    case "Write": {
      const fp = extractJsonField(src, "file_path");
      const content = extractJsonField(src, "content");
      if (fp) lines.push(`:page_facing_up: \`${fp}\``);
      if (content) lines.push(`\`\`\`${content}\`\`\``);
      break;
    }
    case "Read": {
      const fp = extractJsonField(src, "file_path");
      if (fp) lines.push(`:page_facing_up: \`${fp}\``);
      break;
    }
    default: {
      const pairs = src.matchAll(/"(\w+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
      for (const m of pairs) {
        lines.push(`*${m[1]}*: \`${m[2]}\``);
      }
    }
  }

  if (lines.length > 0) return lines.join("\n");

  if (description && description !== inputPreview) return description;
  return `\`\`\`${src}\`\`\``;
}

/**
 * Handle a permission request from Claude Code via MCP notification.
 *
 * Sends a Slack message with Block Kit buttons and waits for user click.
 * When the user clicks, sends the verdict back via MCP notification.
 */
async function handlePermissionRequest(params: {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}): Promise<void> {
  stderr(`Permission request: ${params.tool_name} (id=${params.request_id})`);

  if (!lastActiveChannelId) {
    stderr("No active channel for permission request, ignoring (CLI prompt remains)");
    return;
  }

  try {
    const action = formatPreview(
      params.tool_name,
      params.input_preview,
      params.description,
    );
    const text = `:lock: *권한 요청*: \`${params.tool_name}\`\n${action}`;

    await web.chat.postMessage({
      channel: lastActiveChannelId,
      text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "✅ 허용" },
              action_id: `perm:allow:${params.request_id}`,
              style: "primary",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "❌ 거부" },
              action_id: `perm:deny:${params.request_id}`,
              style: "danger",
            },
          ],
        },
      ],
      ...(lastActiveThreadTs ? { thread_ts: lastActiveThreadTs } : {}),
    });
  } catch (err) {
    stderr(`Failed to send permission request to Slack: ${err}`);
  }
}

/**
 * Send a permission verdict back to Claude Code via MCP notification.
 */
async function sendPermissionVerdict(
  requestId: string,
  behavior: "allow" | "deny",
): Promise<void> {
  try {
    await mcp.server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: requestId, behavior },
    });
    stderr(`Permission verdict sent: ${requestId} → ${behavior}`);
  } catch (err) {
    stderr(`Failed to send permission verdict: ${err}`);
  }
}

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

  lastActiveChannelId = event.channel;
  lastActiveThreadTs = event.thread_ts;

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

socketMode.on("interactive", async ({ body, ack }) => {
  await ack();

  if (body.type !== "block_actions" || !body.actions?.length) return;

  const action = body.actions[0];
  if (!action.action_id?.startsWith("perm:")) return;

  const parts = action.action_id.split(":");
  const [, behavior, requestId] = parts as [string, string, string];
  if (!requestId || (behavior !== "allow" && behavior !== "deny")) return;

  const allow = behavior === "allow";
  stderr(`Button clicked: ${behavior} for request_id=${requestId}`);

  await sendPermissionVerdict(requestId, behavior as "allow" | "deny");

  // Update message: remove buttons, show result
  try {
    const channel = body.channel?.id;
    const ts = body.message?.ts;
    if (channel && ts) {
      const original = body.message?.text ?? "";
      const result = allow
        ? ":white_check_mark: 권한 허용됨"
        : ":x: 권한 거부됨";
      await web.chat.update({
        channel,
        ts,
        text: original + "\n\n" + result,
        blocks: [],
      });
    }
  } catch {
    // ignore update failure
  }
});

socketMode.on("connected", () => {
  stderr("Slack Socket Mode connected");
});

// ── startup ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Connect IPC to wrapper
  try {
    ipc = await connectToWrapper(WRAPPER_SOCKET);
    ipc.on("message", (ipcMsg: WrapperToMcp) => {
      if (ipcMsg.type === "config") {
        currentModel = ipcMsg.model;
        currentCwd = ipcMsg.cwd;
        stderr(`Config received: model=${ipcMsg.model} cwd=${ipcMsg.cwd}`);
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
