/**
 * Sanitization and path-safety helpers shared by both MCP servers.
 *
 * Exports:
 *   safeAttName — strip delimiter characters from user-supplied attachment names.
 *   isSendablePath — allow files only from explicit workspace roots or the
 *                    downloaded-attachments inbox.
 *
 * Example:
 *   >>> safeAttName("evil\nname]hack");
 *   "evil_name_hack"
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve, sep } from "node:path";
import { CONFIG_HOME, DATA_DIR } from "./paths.js";

const ATTACHMENTS_DIR = `${DATA_DIR}${sep}attachments`;
export const ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_ATTACHMENT_STORAGE_BYTES = 512 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_CONCURRENT_ATTACHMENT_DOWNLOADS = 4;
export const MAX_QUEUED_ATTACHMENT_DOWNLOADS = 32;

/**
 * Strip characters that would let an uploader forge new rows in the
 * channel-notification meta or in tool-result text.
 *
 * The attachment name is uploader-controlled and lands inside text frames
 * that use ``[name]`` annotations, ``;`` separators, and newline-joined
 * listings. Replacing those characters with ``_`` keeps the value visible
 * but eliminates its ability to break out of the surrounding frame.
 *
 * Args:
 *   name: Original filename (may be null/empty).
 *   fallback: Value to use when ``name`` is null or empty.
 *
 * Returns:
 *   Sanitized name, or ``fallback`` when no usable name was given.
 */
export function safeAttName(name: string | null | undefined, fallback = "file"): string {
  const sanitize = (value: string): string => {
    const normalized = value
      .trim()
      // Both POSIX and Windows separators must be removed. Attachment names
      // come from remote users and are later passed to path.join/resolve.
      .replace(/[\/\\\0]/g, "_")
      // Keep prompt-prefix delimiters and Windows-special filename characters
      // from creating ambiguous text or alternate data streams.
      .replace(/[\[\]\r\n;<>:"|?*\u0001-\u001f]/g, "_");
    return normalized === "." || normalized === ".." ? "" : normalized;
  };

  return sanitize(name ?? "") || sanitize(fallback) || "file";
}

/**
 * Resolve one child path and prove that it stays inside its intended directory.
 *
 * Filename sanitization is the first line of defence; this containment check is
 * deliberately separate so a future sanitizer regression cannot turn an
 * attachment download or cleanup into an arbitrary filesystem write/removal.
 */
export function resolveContainedPath(directory: string, child: string): string {
  const root = resolve(directory);
  const candidate = resolve(root, child);
  if (candidate === root || !candidate.startsWith(root + sep)) {
    throw new Error(`attachment path escapes its storage directory: ${child}`);
  }
  return candidate;
}

type QueuedAttachmentTask = () => void;

/**
 * Bound attachment I/O across concurrent platform event handlers.
 *
 * Discord and Slack dispatch different messages in parallel. Without a
 * process-wide gate, many allowed 10 MB downloads can simultaneously retain
 * network buffers and exhaust the bot. The queue is bounded as well so a
 * sustained burst fails individual attachments instead of accumulating an
 * unbounded number of closures.
 */
export class AttachmentDownloadPool {
  private active = 0;
  private readonly queue: QueuedAttachmentTask[] = [];

  constructor(
    private readonly concurrency = MAX_CONCURRENT_ATTACHMENT_DOWNLOADS,
    private readonly maxQueued = MAX_QUEUED_ATTACHMENT_DOWNLOADS,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("attachment download concurrency must be positive");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("attachment download queue limit cannot be negative");
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const start = (): void => {
        this.active += 1;
        void Promise.resolve()
          .then(operation)
          .then(resolvePromise, rejectPromise)
          .finally(() => {
            this.active -= 1;
            this.queue.shift()?.();
          });
      };

      if (this.active < this.concurrency) {
        start();
        return;
      }
      if (this.queue.length >= this.maxQueued) {
        rejectPromise(new Error("attachment download queue is full"));
        return;
      }
      this.queue.push(start);
    });
  }
}

const attachmentDownloadPool = new AttachmentDownloadPool();

/**
 * Fetch one attachment into a private temporary file, then atomically publish
 * it at the destination after the complete body passes the byte limit.
 */
export async function downloadAttachmentToFile(
  url: string,
  destination: string,
  maxBytes: number,
  init: RequestInit = {},
  timeoutMs = DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
): Promise<number> {
  return attachmentDownloadPool.run(async () => {
    const boundedMax = Math.max(0, maxBytes);
    const boundedTimeout = Math.max(1, timeoutMs);
    const controller = new AbortController();
    const externalSignal = init.signal;
    const abortFromExternal = (): void => controller.abort(
      externalSignal?.reason,
    );
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener("abort", abortFromExternal, {
      once: true,
    });

    const timer = setTimeout(() => {
      controller.abort(
        new Error(`attachment download timed out after ${boundedTimeout}ms`),
      );
    }, boundedTimeout);
    timer.unref?.();

    const tempPath = resolveContainedPath(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`,
    );
    let fd: number | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let published = false;
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`attachment download failed with HTTP ${response.status}`);
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > boundedMax) {
        throw new Error(`attachment response exceeds ${boundedMax} bytes`);
      }
      if (!response.body) {
        fd = openSync(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          0o600,
        );
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(tempPath, destination);
        published = true;
        return 0;
      }

      fd = openSync(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      reader = response.body.getReader();
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > boundedMax) {
          await reader.cancel();
          throw new Error(`attachment response exceeds ${boundedMax} bytes`);
        }
        let offset = 0;
        while (offset < value.byteLength) {
          offset += writeSync(
            fd,
            value,
            offset,
            value.byteLength - offset,
          );
        }
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(tempPath, destination);
      published = true;
      return totalBytes;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromExternal);
      reader?.releaseLock();
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Best-effort cleanup after a failed write.
        }
      }
      if (!published) {
        try {
          unlinkSync(tempPath);
        } catch {
          // The temp file may not have been created yet.
        }
      }
    }
  });
}

interface AttachmentStorageEntry {
  path: string;
  bytes: number;
  lastModifiedMs: number;
}

export interface AttachmentPruneOptions {
  maxAgeMs?: number;
  maxBytes?: number;
  reserveBytes?: number;
  now?: number;
}

function attachmentStorageEntry(path: string): AttachmentStorageEntry | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) {
      return {
        path,
        bytes: stat.size,
        lastModifiedMs: stat.mtimeMs,
      };
    }

    let bytes = 0;
    let lastModifiedMs = stat.mtimeMs;
    for (const child of readdirSync(path)) {
      const nested = attachmentStorageEntry(resolveContainedPath(path, child));
      if (!nested) continue;
      bytes += nested.bytes;
      lastModifiedMs = Math.max(lastModifiedMs, nested.lastModifiedMs);
    }
    return { path, bytes, lastModifiedMs };
  } catch {
    // A concurrent download/cleanup may remove an entry while it is scanned.
    return null;
  }
}

/**
 * Remove expired attachment directories, then evict oldest entries until the
 * global storage budget has room for the next message.
 */
export function pruneAttachmentStorage(
  directory: string,
  options: AttachmentPruneOptions = {},
): void {
  const maxAgeMs = Math.max(
    0,
    options.maxAgeMs ?? ATTACHMENT_RETENTION_MS,
  );
  const maxBytes = Math.max(
    0,
    options.maxBytes ?? MAX_ATTACHMENT_STORAGE_BYTES,
  );
  const reserveBytes = Math.min(
    maxBytes,
    Math.max(0, options.reserveBytes ?? 0),
  );
  const cutoff = (options.now ?? Date.now()) - maxAgeMs;

  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }

  const retained: AttachmentStorageEntry[] = [];
  for (const name of names) {
    let path: string;
    try {
      path = resolveContainedPath(directory, name);
    } catch {
      continue;
    }
    const entry = attachmentStorageEntry(path);
    if (!entry) continue;
    if (entry.lastModifiedMs < cutoff) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Best-effort cache cleanup must never drop the inbound user message.
      }
      continue;
    }
    retained.push(entry);
  }

  const targetBytes = maxBytes - reserveBytes;
  let totalBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
  retained.sort((left, right) => left.lastModifiedMs - right.lastModifiedMs);
  for (const entry of retained) {
    if (totalBytes <= targetBytes) break;
    try {
      rmSync(entry.path, { recursive: true, force: true });
      totalBytes -= entry.bytes;
    } catch {
      // Try the next entry; another process may already be changing this one.
    }
  }
}

/**
 * Read a fetch response without trusting its declared Content-Length.
 *
 * Slack/Discord metadata provides a file size, but the response body is the
 * authoritative byte stream. Cancelling as soon as the bound is crossed keeps
 * a stale or malicious response from allocating an unbounded ArrayBuffer.
 */
export async function readResponseBuffer(
  response: Response,
  maxBytes: number,
  timeoutMs = DEFAULT_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
): Promise<Buffer> {
  const boundedMax = Math.max(0, maxBytes);
  const boundedTimeout = Math.max(1, timeoutMs);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > boundedMax) {
    throw new Error(`attachment response exceeds ${boundedMax} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let rejectTimeout: ((reason: Error) => void) | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error(
      `attachment download timed out after ${boundedTimeout}ms`,
    );
    rejectTimeout?.(error);
    void reader.cancel(error).catch(() => {});
  }, boundedTimeout);
  timer.unref?.();
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > boundedMax) {
        await reader.cancel();
        throw new Error(`attachment response exceeds ${boundedMax} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

/**
 * Decide whether a file path is safe to surface back through the chat.
 *
 * The reply tool's ``files`` argument is model-controlled. Without this
 * allowlist, a prompt-injected message could ask the assistant to send any
 * file readable by the MCP process back as a Discord / Slack attachment,
 * bypassing the agent sandbox.
 *
 * Args:
 *   path: Absolute path the model wants to attach.
 *   allowedRoots: Workspace/output directories whose descendants may be sent.
 *
 * Returns:
 *   true only if the existing path resolves inside an explicit allowed root
 *   or the downloaded-attachments inbox. ``CONFIG_HOME`` remains private
 *   even when an overly-broad workspace root contains it.
 */
function resolveSendableFile(
  path: string,
  allowedRoots: readonly string[] = [],
): { real: string; stat: Stats } {
  let real: string;
  let stat: Stats;
  try {
    real = realpathSync(path);
    stat = statSync(real);
    if (!stat.isFile()) throw new Error("path is not a regular file");
  } catch {
    throw new Error("file does not exist or is not a regular file");
  }

  // dotenv files commonly contain the bot tokens and other credentials.
  // Block them even when they live inside the configured workspace (or are
  // reached through a symlink whose friendly name hides the real basename).
  const realBasename = basename(real).toLowerCase();
  const requestedBasename = basename(path).toLowerCase();
  if (
    realBasename === ".env" ||
    realBasename.startsWith(".env.") ||
    requestedBasename === ".env" ||
    requestedBasename.startsWith(".env.")
  ) {
    throw new Error("dotenv files cannot be sent");
  }

  const isWithin = (candidate: string, root: string): boolean =>
    candidate === root || candidate.startsWith(root + sep);

  let attachmentsReal: string | null = null;
  try {
    attachmentsReal = realpathSync(ATTACHMENTS_DIR);
  } catch {
    // The inbox may not exist until the first attachment is downloaded.
  }
  if (attachmentsReal && isWithin(real, attachmentsReal)) {
    return { real, stat };
  }

  let configReal: string | null = null;
  try {
    configReal = realpathSync(CONFIG_HOME);
  } catch {
    // A missing config directory has no private descendants yet.
  }
  if (configReal && isWithin(real, configReal)) {
    throw new Error("configuration files cannot be sent");
  }

  const allowed = allowedRoots.some((root) => {
    try {
      return isWithin(real, realpathSync(root));
    } catch {
      return false;
    }
  });
  if (!allowed) throw new Error("file is outside the active workspace");
  return { real, stat };
}

export function isSendablePath(
  path: string,
  allowedRoots: readonly string[] = [],
): boolean {
  try {
    resolveSendableFile(path, allowedRoots);
    return true;
  } catch {
    return false;
  }
}

export interface SendableFile {
  data: Buffer;
  filename: string;
  size: number;
}

/**
 * Validate and snapshot an outbound attachment before handing it to an SDK.
 *
 * Returning a Buffer is intentional: passing the model-controlled path after
 * validation would let another process replace a symlink or path component
 * before Discord/Slack opens it. Device/inode comparison also detects a swap
 * between canonicalization and open.
 */
export function readSendableFile(
  path: string,
  allowedRoots: readonly string[],
  maxBytes: number,
): SendableFile {
  const boundedMax = Math.max(0, maxBytes);
  const resolved = resolveSendableFile(path, allowedRoots);
  if (resolved.stat.size > boundedMax) {
    throw new Error(
      `file too large: ${path} (${
        (resolved.stat.size / 1024 / 1024).toFixed(1)
      }MB, max ${(boundedMax / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  const fd = openSync(
    resolved.real,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== resolved.stat.dev ||
      opened.ino !== resolved.stat.ino
    ) {
      throw new Error("file changed while it was being validated");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = boundedMax - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining + 1));
      const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > boundedMax) {
        throw new Error(
          `file too large: ${path} (max ${
            (boundedMax / 1024 / 1024).toFixed(1)
          }MB)`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    return {
      data: Buffer.concat(chunks, totalBytes),
      filename: safeAttName(basename(path), basename(resolved.real)),
      size: totalBytes,
    };
  } finally {
    closeSync(fd);
  }
}
