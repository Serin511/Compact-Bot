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
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ATTACHMENTS_DIR = resolve(process.cwd(), "data", "attachments");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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
): Promise<AttachmentResult> {
  if (message.attachments.size === 0) {
    return { promptPrefix: "", paths: [], metadata: [] };
  }

  const dir = join(ATTACHMENTS_DIR, message.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  const paths: string[] = [];
  const metadata: AttachmentResult["metadata"] = [];

  for (const attachment of message.attachments.values()) {
    if (attachment.size > MAX_FILE_SIZE) {
      lines.push(
        `[첨부파일 "${attachment.name}" 은 ${Math.round(attachment.size / 1024 / 1024)}MB로 크기 제한(10MB)을 초과하여 건너뜀]`,
      );
      continue;
    }

    const filePath = join(dir, attachment.name);
    metadata.push({
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
    });

    try {
      const res = await fetch(attachment.url);
      if (!res.ok) {
        lines.push(`[첨부파일 "${attachment.name}" 다운로드 실패]`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);
      paths.push(filePath);

      const isImage = attachment.contentType?.startsWith("image/") ?? false;
      if (isImage) {
        lines.push(`[첨부 이미지: ${filePath}]`);
      } else {
        lines.push(`[첨부 파일: ${filePath}]`);
      }
    } catch {
      lines.push(`[첨부파일 "${attachment.name}" 다운로드 실패]`);
    }
  }

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
): Promise<AttachmentResult> {
  if (metadata.length === 0) {
    return { promptPrefix: "", paths: [], metadata };
  }

  const dir = join(ATTACHMENTS_DIR, messageId + "-retry");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  const paths: string[] = [];

  for (const att of metadata) {
    const filePath = join(dir, att.name);
    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        lines.push(`[첨부파일 "${att.name}" 다운로드 실패]`);
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);
      paths.push(filePath);

      const isImage = att.contentType?.startsWith("image/") ?? false;
      if (isImage) {
        lines.push(`[첨부 이미지: ${filePath}]`);
      } else {
        lines.push(`[첨부 파일: ${filePath}]`);
      }
    } catch {
      lines.push(`[첨부파일 "${att.name}" 다운로드 실패]`);
    }
  }

  const promptPrefix = lines.length > 0 ? lines.join("\n") + "\n\n" : "";
  return { promptPrefix, paths, metadata };
}

/**
 * Remove the temporary attachment directory for a message.
 *
 * Args:
 *   messageId: Message ID whose attachments should be cleaned up.
 */
export function cleanupAttachments(messageId: string): void {
  for (const suffix of ["", "-retry"]) {
    const dir = join(ATTACHMENTS_DIR, messageId + suffix);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
