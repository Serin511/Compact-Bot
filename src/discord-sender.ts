/**
 * Discord response formatting, message splitting, and streaming edit.
 *
 * Handles the 2000-character Discord message limit by splitting responses
 * at code block boundaries and providing real-time edit-based streaming.
 *
 * Exports:
 *   DiscordSender.
 *
 * Example:
 *   >>> const sender = new DiscordSender(message, 1500);
 *   >>> await sender.startProcessing();
 *   >>> await sender.appendText("Hello");
 *   >>> await sender.finish();
 */

import {
  type Message,
  type TextChannel,
  AttachmentBuilder,
} from "discord.js";
import { msg } from "./messages.js";


const MAX_MSG_LEN = 1900;
const CODE_ATTACHMENT_THRESHOLD = 1500;

/**
 * Split text into chunks respecting code block boundaries.
 *
 * Args:
 *   text: Text to split.
 *   maxLen: Maximum characters per chunk.
 *
 * Returns:
 *   Array of text chunks, each within maxLen.
 */
export function splitMessage(text: string, maxLen = MAX_MSG_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeLang = "";

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLen;

    // Try to split at a newline near the limit
    const lastNewline = remaining.lastIndexOf("\n", maxLen);
    if (lastNewline > maxLen * 0.5) {
      splitAt = lastNewline + 1;
    }

    let chunk = remaining.slice(0, splitAt);
    remaining = remaining.slice(splitAt);

    // Track code block state
    const codeBlockMatches = chunk.match(/```/g);
    if (codeBlockMatches) {
      const count = codeBlockMatches.length;
      if (inCodeBlock && count % 2 === 1) {
        // Close the open code block at end of chunk
        chunk += "\n```";
        remaining = "```" + codeLang + "\n" + remaining;
        inCodeBlock = false;
      } else if (!inCodeBlock && count % 2 === 1) {
        // A code block was opened but not closed
        const lastOpen = chunk.lastIndexOf("```");
        const langMatch = chunk.slice(lastOpen + 3).match(/^(\w*)/);
        codeLang = langMatch?.[1] ? "\n" : "";
        chunk += "\n```";
        remaining = "```" + (langMatch?.[1] ?? "") + "\n" + remaining;
        inCodeBlock = false;
      }
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Format tool usage for display in Discord.
 *
 * Args:
 *   toolName: Name of the tool being used.
 *   input: Tool input object.
 *
 * Returns:
 *   Formatted string for Discord display.
 */
export function formatToolUse(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Read":
      return `🔧 Read: \`${input.file_path ?? "?"}\``;
    case "Write":
      return `🔧 Write: \`${input.file_path ?? "?"}\``;
    case "Edit":
      return `🔧 Edit: \`${input.file_path ?? "?"}\``;
    case "Glob":
      return `🔧 Glob: \`${input.pattern ?? "?"}\``;
    case "Grep":
      return `🔧 Grep: \`${input.pattern ?? "?"}\``;
    case "Bash":
      return `🔧 Bash: \`${truncate(String(input.command ?? "?"), 100)}\``;
    default:
      return `🔧 ${toolName}`;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export class DiscordSender {
  private channel: TextChannel;
  private currentMessage: Message | null = null;
  private buffer = "";
  private sentMessages: Message[] = [];
  private toolLines: string[] = [];
  private flushedOnce = false;

  constructor(public readonly sourceMessage: Message) {
    this.channel = sourceMessage.channel as TextChannel;
  }

  /**
   * Get IDs of all messages sent by the bot during this session.
   *
   * Returns:
   *   Array of Discord message IDs.
   */
  getSentMessageIds(): string[] {
    return this.sentMessages.map((m) => m.id);
  }

  /**
   * Send the initial "processing" indicator message.
   */
  async startProcessing(): Promise<void> {
    this.currentMessage = await this.channel.send(msg("processing"));
    this.sentMessages.push(this.currentMessage);
  }

  /**
   * Record a tool usage event for inline display.
   *
   * Args:
   *   toolName: Tool being invoked.
   *   input: Tool input parameters.
   */
  addToolUse(toolName: string, input: Record<string, unknown>): void {
    this.toolLines.push(formatToolUse(toolName, input));
  }

  /**
   * Append streamed text to the internal buffer.
   *
   * Text is accumulated and sent all at once when finish() is called.
   *
   * Args:
   *   text: Text chunk to append.
   */
  async appendText(text: string): Promise<void> {
    this.buffer += text;
  }


  /**
   * Build the display string from tool lines and text buffer.
   */
  private buildDisplay(): string {
    const parts: string[] = [];
    if (this.toolLines.length > 0) {
      parts.push(this.toolLines.join("\n"));
    }
    if (this.buffer.trim()) {
      parts.push(this.buffer);
    }
    return parts.join("\n\n");
  }

  /**
   * Send the current buffer content immediately.
   *
   * First call edits the processing indicator; subsequent calls send new
   * messages. Resets the buffer after sending.
   */
  async flush(): Promise<void> {
    const display = this.buildDisplay();
    if (!display || !this.currentMessage) return;

    const chunks = splitMessage(display);

    if (!this.flushedOnce) {
      // First flush — edit the processing indicator
      await this.currentMessage.edit(chunks[0]!);
      this.flushedOnce = true;
    } else {
      // Subsequent flushes — send as a new message
      const newMsg = await this.channel.send(chunks[0]!);
      this.sentMessages.push(newMsg);
      this.currentMessage = newMsg;
    }

    for (let i = 1; i < chunks.length; i++) {
      const newMsg = await this.channel.send(chunks[i]!);
      this.sentMessages.push(newMsg);
      this.currentMessage = newMsg;
    }

    this.buffer = "";
    this.toolLines = [];
  }

  /**
   * Finalize the response: flush any remaining buffered content.
   */
  async finish(): Promise<void> {
    await this.flush();
  }

  /**
   * Check whether the internal buffer has any displayable content.
   *
   * Returns:
   *   True if there is buffered text or tool lines.
   */
  hasContent(): boolean {
    return this.buffer.trim().length > 0 || this.toolLines.length > 0;
  }

  /**
   * Edit the current (most recent) bot message in-place.
   *
   * Args:
   *   text: Replacement text for the message.
   */
  async editCurrentMessage(text: string): Promise<void> {
    if (this.currentMessage) {
      await this.currentMessage.edit(text);
    }
  }

  /**
   * Send a standalone message (for command responses like /cost, /clear).
   *
   * Args:
   *   content: Message content to send.
   */
  async sendReply(content: string): Promise<void> {
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await this.channel.send(chunk);
    }
  }

  /**
   * Send a file attachment to the channel.
   *
   * Args:
   *   content: File content as string.
   *   filename: Name for the attached file.
   */
  async sendAttachment(content: string, filename: string): Promise<void> {
    const attachment = new AttachmentBuilder(Buffer.from(content), {
      name: filename,
    });
    await this.channel.send({ files: [attachment] });
  }
}
