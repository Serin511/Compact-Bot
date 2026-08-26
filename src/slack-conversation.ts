/**
 * Resolve one Slack message inside an exact top-level or threaded conversation.
 *
 * Slack uses the same channel ID for every thread, so checking only `channel`
 * is insufficient for mutable tools such as react/edit and for attachment
 * downloads. Thread replies are paginated with a hard bound; top-level lookup
 * uses an exact timestamp comparison because `latest` can otherwise return a
 * neighboring message.
 */

export interface SlackConversationMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: unknown[];
}

export interface SlackConversationPage {
  messages?: SlackConversationMessage[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackConversationApi {
  replies(args: {
    channel: string;
    ts: string;
    limit: number;
    cursor?: string;
  }): Promise<SlackConversationPage>;
  history(args: {
    channel: string;
    latest: string;
    inclusive: true;
    limit: 1;
  }): Promise<SlackConversationPage>;
}

const MAX_THREAD_LOOKUP_MESSAGES = 500;

export async function findSlackConversationMessage(
  api: SlackConversationApi,
  channel: string,
  messageId: string,
  threadTs?: string,
): Promise<SlackConversationMessage | undefined> {
  if (!threadTs) {
    const result = await api.history({
      channel,
      latest: messageId,
      inclusive: true,
      limit: 1,
    });
    const candidate = result.messages?.[0];
    return candidate?.ts === messageId ? candidate : undefined;
  }

  let cursor: string | undefined;
  let seen = 0;
  while (seen < MAX_THREAD_LOOKUP_MESSAGES) {
    const result = await api.replies({
      channel,
      ts: threadTs,
      limit: Math.min(100, MAX_THREAD_LOOKUP_MESSAGES - seen),
      ...(cursor ? { cursor } : {}),
    });
    const messages = result.messages ?? [];
    const match = messages.find((candidate) => candidate.ts === messageId);
    if (match) return match;
    seen += messages.length;
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor || messages.length === 0) return undefined;
  }
  return undefined;
}
