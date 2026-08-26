/**
 * Download Discord message attachments to a local temp directory.
 *
 * Saves files under data/attachments/<messageId>/ and builds a prompt
 * prefix describing the files so Claude can read them via its tools.
 *
 * Exports:
 *   downloadAttachments, cleanupAttachments.
 *
 * Example:
 *   >>> const result = await downloadAttachments(message);
 *   >>> console.log(result.promptPrefix);
 *   // "[첨부 이미지: /abs/path/image.png]\n"
 */

import { type Message } from "discord.js";
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

export interface AttachmentResult {
  promptPrefix: string;
  paths: string[];
  metadata: { name: string; url: string; contentType: string | null }[];
}

/**
 * Download all attachments from a Discord message to a local directory.
 *
 * Args:
 *   message: Discord.js Message object.
 *
 * Returns:
 *   AttachmentResult with prompt prefix, local paths, and metadata.
 */
export async function downloadAttachments(
  message: Message,
  storageDir = ATTACHMENTS_DIR,
): Promise<AttachmentResult> {
  if (message.attachments.size === 0) {
    return { promptPrefix: "", paths: [], metadata: [] };
  }

  const reserveBytes = Math.min(
    MAX_MESSAGE_ATTACHMENT_BYTES,
    [...message.attachments.values()].reduce(
      (total, attachment) =>
        attachment.size <= MAX_FILE_SIZE
          ? total + Math.max(0, attachment.size)
          : total,
      0,
    ),
  );
  pruneAttachmentStorage(storageDir, { reserveBytes });

  const dir = resolveContainedPath(
    storageDir,
    safeAttName(message.id, "message"),
  );
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const lines: string[] = [];
  const paths: string[] = [];
  const metadata: AttachmentResult["metadata"] = [];
  let downloadedBytes = 0;

  for (const attachment of message.attachments.values()) {
    // Sanitize the uploader-controlled filename before using it as a
    // local path component or surfacing it back as text — without this,
    // a name containing newlines / brackets / semicolons can forge new
    // rows in the prompt-prefix or notification meta.
    const safeName = safeAttName(attachment.name, attachment.id);
    if (attachment.size > MAX_FILE_SIZE) {
      lines.push(
        msg("attachmentTooLarge", {
          name: safeName,
          size: String(Math.round(attachment.size / 1024 / 1024)),
        }),
      );
      continue;
    }
    if (
      downloadedBytes + Math.max(0, attachment.size) >
      MAX_MESSAGE_ATTACHMENT_BYTES
    ) {
      lines.push(messageLimitLine(safeName));
      continue;
    }

    const filePath = resolveContainedPath(dir, safeName);
    metadata.push({
      name: safeName,
      url: attachment.url,
      contentType: attachment.contentType,
    });

    try {
      const remainingBytes =
        MAX_MESSAGE_ATTACHMENT_BYTES - downloadedBytes;
      const bytes = await downloadAttachmentToFile(
        attachment.url,
        filePath,
        Math.min(MAX_FILE_SIZE, remainingBytes),
      );
      downloadedBytes += bytes;
      paths.push(filePath);

      const isImage = attachment.contentType?.startsWith("image/") ?? false;
      if (isImage) {
        lines.push(msg("attachmentImage", { path: filePath }));
      } else {
        lines.push(msg("attachmentFile", { path: filePath }));
      }
    } catch {
      lines.push(msg("attachmentFailed", { name: safeName }));
    }
  }

  pruneAttachmentStorage(storageDir);
  const promptPrefix = lines.length > 0 ? lines.join("\n") + "\n\n" : "";
  return { promptPrefix, paths, metadata };
}

/**
 * Re-download attachments from stored metadata (for retry).
 *
 * Args:
 *   messageId: Original message ID (used as directory name).
 *   metadata: Attachment metadata from previous download.
 *
 * Returns:
 *   AttachmentResult with rebuilt prompt prefix and fresh local paths.
 */
export async function redownloadAttachments(
  messageId: string,
  metadata: AttachmentResult["metadata"],
  storageDir = ATTACHMENTS_DIR,
): Promise<AttachmentResult> {
  if (metadata.length === 0) {
    return { promptPrefix: "", paths: [], metadata };
  }

  pruneAttachmentStorage(storageDir, {
    reserveBytes: MAX_MESSAGE_ATTACHMENT_BYTES,
  });
  const dir = resolveContainedPath(
    storageDir,
    `${safeAttName(messageId, "message")}-retry`,
  );
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const lines: string[] = [];
  const paths: string[] = [];
  let downloadedBytes = 0;

  for (const att of metadata) {
    // Metadata may have been written by an older version that did not
    // sanitize names; re-apply on the retry path too.
    const safeName = safeAttName(att.name);
    if (downloadedBytes >= MAX_MESSAGE_ATTACHMENT_BYTES) {
      lines.push(messageLimitLine(safeName));
      continue;
    }
    const filePath = resolveContainedPath(dir, safeName);
    try {
      const remainingBytes =
        MAX_MESSAGE_ATTACHMENT_BYTES - downloadedBytes;
      const bytes = await downloadAttachmentToFile(
        att.url,
        filePath,
        Math.min(MAX_FILE_SIZE, remainingBytes),
      );
      downloadedBytes += bytes;
      paths.push(filePath);

      const isImage = att.contentType?.startsWith("image/") ?? false;
      if (isImage) {
        lines.push(msg("attachmentImage", { path: filePath }));
      } else {
        lines.push(msg("attachmentFile", { path: filePath }));
      }
    } catch {
      lines.push(msg("attachmentFailed", { name: safeName }));
    }
  }

  pruneAttachmentStorage(storageDir);
  const promptPrefix = lines.length > 0 ? lines.join("\n") + "\n\n" : "";
  return { promptPrefix, paths, metadata };
}

/**
 * Remove the temporary attachment directory for a message.
 *
 * Args:
 *   messageId: Message ID whose attachments should be cleaned up.
 */
export function cleanupAttachments(
  messageId: string,
  storageDir = ATTACHMENTS_DIR,
): void {
  const safeMessageId = safeAttName(messageId, "message");
  for (const suffix of ["", "-retry"]) {
    const dir = resolveContainedPath(
      storageDir,
      safeMessageId + suffix,
    );
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
