/**
 * In-memory tracker for active CLI processes and last user messages.
 *
 * Tracks AbortControllers for cancel-by-reaction and stores the last
 * user message per channel for retry-by-reaction.
 *
 * Exports:
 *   processTracker, ActiveProcess, LastUserMessage.
 *
 * Example:
 *   >>> const ctrl = processTracker.startProcess("ch-1", "msg-1");
 *   >>> processTracker.cancelProcess("ch-1"); // kills the CLI
 */

export interface ActiveProcess {
  abortController: AbortController;
  userMessageId: string;
  channelId: string;
  botMessageIds: Set<string>;
}

export interface LastUserMessage {
  messageId: string;
  content: string;
  replyContext: string;
  attachments: { name: string; url: string; contentType: string | null }[];
}

class ProcessTracker {
  private activeProcesses = new Map<string, ActiveProcess>();
  private lastMessages = new Map<string, LastUserMessage>();

  /**
   * Register a new active process for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *   userMessageId: The user's triggering message ID.
   *
   * Returns:
   *   AbortController to wire into callClaude.
   */
  startProcess(channelId: string, userMessageId: string): AbortController {
    const abortController = new AbortController();
    this.activeProcesses.set(channelId, {
      abortController,
      userMessageId,
      channelId,
      botMessageIds: new Set(),
    });
    return abortController;
  }

  /**
   * Get the active process for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   ActiveProcess or undefined.
   */
  getProcess(channelId: string): ActiveProcess | undefined {
    return this.activeProcesses.get(channelId);
  }

  /**
   * Register a bot message ID for the active process.
   *
   * Args:
   *   channelId: Discord channel ID.
   *   botMessageId: The bot's reply message ID.
   */
  addBotMessageId(channelId: string, botMessageId: string): void {
    this.activeProcesses.get(channelId)?.botMessageIds.add(botMessageId);
  }

  /**
   * Cancel the active process for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   True if a process was found and cancelled.
   */
  cancelProcess(channelId: string): boolean {
    const proc = this.activeProcesses.get(channelId);
    if (!proc) return false;
    proc.abortController.abort();
    return true;
  }

  /**
   * Check if a message ID belongs to the active process (user or bot).
   *
   * Args:
   *   channelId: Discord channel ID.
   *   messageId: Message ID to check.
   *
   * Returns:
   *   True if the message is part of the active process.
   */
  isProcessMessage(channelId: string, messageId: string): boolean {
    const proc = this.activeProcesses.get(channelId);
    if (!proc) return false;
    return (
      proc.userMessageId === messageId || proc.botMessageIds.has(messageId)
    );
  }

  /**
   * Remove the active process entry for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   */
  finishProcess(channelId: string): void {
    this.activeProcesses.delete(channelId);
  }

  /**
   * Store the last user message for a channel (for retry).
   *
   * Args:
   *   channelId: Discord channel ID.
   *   msg: Last user message data.
   */
  setLastMessage(channelId: string, msg: LastUserMessage): void {
    this.lastMessages.set(channelId, msg);
  }

  /**
   * Get the last user message for a channel.
   *
   * Args:
   *   channelId: Discord channel ID.
   *
   * Returns:
   *   LastUserMessage or undefined.
   */
  getLastMessage(channelId: string): LastUserMessage | undefined {
    return this.lastMessages.get(channelId);
  }
}

export const processTracker = new ProcessTracker();
