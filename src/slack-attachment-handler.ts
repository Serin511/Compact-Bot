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
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { msg } from "./messages.js";

const ATTACHMENTS_DIR = resolve(process.cwd(), "data", "attachments");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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
): Promise<SlackAttachmentResult> {
  if (files.length === 0) {
    return { promptPrefix: "", paths: [] };
  }

  const safeTs = messageTs.replace(".", "-");
  const dir = join(ATTACHMENTS_DIR, `slack-${safeTs}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const lines: string[] = [];
  const paths: string[] = [];

  for (const file of files) {
    const name = file.name ?? `file-${file.id}`;

    if (file.size > MAX_FILE_SIZE) {
      lines.push(
        msg("attachmentTooLarge", {
          name,
          size: String(Math.round(file.size / 1024 / 1024)),
        }),
      );
      continue;
    }

    const downloadUrl = file.url_private_download ?? file.url_private;
    if (!downloadUrl) {
      lines.push(msg("attachmentNoUrl", { name }));
      continue;
    }

    const filePath = join(dir, name);

    try {
      const res = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        lines.push(msg("attachmentFailed", { name }));
        continue;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      writeFileSync(filePath, buffer);
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

  const promptPrefix = lines.length > 0 ? lines.join("\n") + "\n\n" : "";
  return { promptPrefix, paths };
}

/**
 * Remove the temporary attachment directory for a Slack message.
 *
 * Args:
 *   messageTs: Message timestamp whose attachments should be cleaned up.
 */
export function cleanupSlackAttachments(messageTs: string): void {
  const safeTs = messageTs.replace(".", "-");
  const dir = join(ATTACHMENTS_DIR, `slack-${safeTs}`);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
