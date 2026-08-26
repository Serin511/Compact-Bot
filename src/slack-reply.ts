/**
 * Pure Slack reply-delivery helpers.
 *
 * File uploads happen after text chunks have already been posted. Upload
 * failures therefore need to return an explicit MCP tool error that also
 * reports the partial text progress, rather than being logged and swallowed.
 */

export type SlackReplyToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export interface SlackReplyFileUpload {
  file: Buffer | string;
  filename: string;
}

export async function uploadSlackReplyFiles(options: {
  channelId: string;
  threadTs?: string;
  files: SlackReplyFileUpload[];
  sentTimestamps: string[];
  upload: (input: {
    channel_id: string;
    thread_ts?: string;
    file_uploads: SlackReplyFileUpload[];
  }) => Promise<unknown>;
  onError?: (error: unknown) => void;
}): Promise<SlackReplyToolResult | null> {
  if (options.files.length === 0) return null;

  try {
    await options.upload({
      channel_id: options.channelId,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      file_uploads: options.files,
    });
    return null;
  } catch (error) {
    options.onError?.(error);
    const message = error instanceof Error ? error.message : String(error);
    const sent = options.sentTimestamps.length > 0
      ? ` (${options.sentTimestamps.join(", ")})`
      : "";
    return {
      content: [{
        type: "text",
        text:
          `reply file upload failed after ` +
          `${options.sentTimestamps.length} message(s) sent${sent}: ${message}`,
      }],
      isError: true,
    };
  }
}
