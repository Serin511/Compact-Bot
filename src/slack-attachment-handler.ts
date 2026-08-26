/**
 * Download Slack message attachments to a local temp directory.
 *
 * Saves files under data/attachments/slack-<messageTs>/ and builds a prompt
 * prefix describing the files so Claude can read them via its tools.
 * Unlike Discord, Slack's url_private requires Bearer token authentication.
 *
 * Exports:
 *   downloadSlackAttachments, cleanupSlackAttachments.
 *
 * Example:
 *   >>> const result = await downloadSlackAttachments(files, "1234567890.123456", token);
 *   >>> console.log(result.promptPrefix);
 *   // "[첨부 이미지: /abs/path/image.png]\n"
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { msg } from "./messages.js";
import { DATA_DIR } from "./paths.js";
import {
  downloadAttachmentToFile,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  pruneAttachmentStorage,
  resolveContainedPath,
  safeAttName,
} from "./sanitize.js";

const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MESSAGE_LIMIT_MB = Math.round(MAX_MESSAGE_ATTACHMENT_BYTES / 1024 / 1024);

function messageLimitLine(name: string): string {
  return `[첨부파일 "${name}" 은 메시지당 총 다운로드 제한(${MESSAGE_LIMIT_MB}MB)을 초과하여 건너뜀]`;
}

export interface SlackFile {
  id: string;
  name: string | null;
  mimetype: string;
  size: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackAttachmentResult {
  promptPrefix: string;
  paths: string[];
}

/**
 * Download all file attachments from a Slack message.
 *
 * Args:
 *   files: Array of Slack file objects from the message event.
 *   messageTs: Message timestamp used as directory name.
 *   token: Slack Bot OAuth token for authenticated downloads.
 *
 * Returns:
 *   SlackAttachmentResult with prompt prefix and local paths.
 */
export async function downloadSlackAttachments(
  files: SlackFile[],
  messageTs: string,
  token: string,
  storageDir = ATTACHMENTS_DIR,
): Promise<SlackAttachmentResult> {
  if (files.length === 0) {
    return { promptPrefix: "", paths: [] };
  }

  const reserveBytes = Math.min(
    MAX_MESSAGE_ATTACHMENT_BYTES,
    files.reduce(
      (total, file) =>
        file.size <= MAX_FILE_SIZE
          ? total + Math.max(0, file.size)
          : total,
      0,
    ),
  );
  pruneAttachmentStorage(storageDir, { reserveBytes });

  const safeTs = safeAttName(messageTs.replaceAll(".", "-"), "message");
  const dir = resolveContainedPath(storageDir, `slack-${safeTs}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const lines: string[] = [];
  const paths: string[] = [];
  let downloadedBytes = 0;

  for (const file of files) {
    // Slack filenames are uploader-controlled — sanitize before using
    // them in a local path or surfacing back as prompt text.
    const name = safeAttName(file.name, `file-${file.id}`);

    if (file.size > MAX_FILE_SIZE) {
      lines.push(
        msg("attachmentTooLarge", {
          name,
          size: String(Math.round(file.size / 1024 / 1024)),
        }),
      );
      continue;
    }
    if (
      downloadedBytes + Math.max(0, file.size) >
      MAX_MESSAGE_ATTACHMENT_BYTES
    ) {
      lines.push(messageLimitLine(name));
      continue;
    }

    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      lines.push(msg("attachmentNoUrl", { name }));
      continue;
    }

    const filePath = resolveContainedPath(dir, name);

    try {
      const remainingBytes =
        MAX_MESSAGE_ATTACHMENT_BYTES - downloadedBytes;
      const bytes = await downloadAttachmentToFile(
        downloadUrl,
        filePath,
        Math.min(MAX_FILE_SIZE, remainingBytes),
        {
        headers: { Authorization: `Bearer ${token}` },
        },
      );
      downloadedBytes += bytes;
      paths.push(filePath);

      const isImage = file.mimetype?.startsWith("image/") ?? false;
      if (isImage) {
        lines.push(msg("attachmentImage", { path: filePath }));
      } else {
        lines.push(msg("attachmentFile", { path: filePath }));
      }
    } catch {
      lines.push(msg("attachmentFailed", { name }));
    }
  }

  pruneAttachmentStorage(storageDir);
  const promptPrefix = lines.length > 0 ? lines.join("\n") + "\n\n" : "";
  return { promptPrefix, paths };
}

/**
 * Remove the temporary attachment directory for a Slack message.
 *
 * Args:
 *   messageTs: Message timestamp whose attachments should be cleaned up.
 */
export function cleanupSlackAttachments(
  messageTs: string,
  storageDir = ATTACHMENTS_DIR,
): void {
  const safeTs = safeAttName(messageTs.replaceAll(".", "-"), "message");
  const dir = resolveContainedPath(storageDir, `slack-${safeTs}`);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
