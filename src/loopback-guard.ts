/**
 * Crash-safe, process-local startup guard backed by loopback TCP listeners.
 *
 * Unix socket cleanup needs a second primitive that disappears automatically
 * if its owner crashes. A deterministic TCP listener provides that property.
 * Multiple candidate ports plus a keyed handshake distinguish another
 * Compact Bot contender from unrelated loopback services.
 */

import net from "node:net";
import { createHash } from "node:crypto";

export interface LoopbackGuardOptions {
  portBase?: number;
  portSpan?: number;
  candidateCount?: number;
  probeTimeoutMs?: number;
}

function tryListen(
  port: number,
  handshake: string,
): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end(handshake));
    server.once("error", () => resolve(null));
    server.listen(
      { host: "127.0.0.1", port, exclusive: true },
      () => {
        server.removeAllListeners("error");
        resolve(server);
      },
    );
  });
}

function probe(
  port: number,
  handshake: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    let received = "";
    const finish = (matches: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(matches);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.length >= handshake.length) {
        finish(received === handshake);
      }
    });
    socket.once("end", () => finish(received === handshake));
    socket.once("error", () => finish(false));
  });
}

/**
 * Acquire a short-lived guard for `key`.
 *
 * Returns null when another Compact Bot process owns the same guard or all
 * candidate ports are unavailable. The returned listener must be closed by
 * the caller after its protected startup/cleanup section.
 */
export async function acquireLoopbackGuard(
  key: string,
  options: LoopbackGuardOptions = {},
): Promise<net.Server | null> {
  const portBase = options.portBase ?? 49_152;
  const portSpan = options.portSpan ?? 16_384;
  const candidateCount = Math.max(1, options.candidateCount ?? 8);
  const timeoutMs = Math.max(1, options.probeTimeoutMs ?? 100);
  if (
    portBase < 1 ||
    portSpan < 1 ||
    portBase + portSpan - 1 > 65_535
  ) {
    throw new Error("Invalid loopback guard port range");
  }

  const guardKey = createHash("sha256").update(key).digest("hex");
  const digest = Buffer.from(guardKey, "hex");
  const handshake = `compact-bot-guard:${guardKey}\n`;
  const ports = new Set<number>();
  for (let offset = 0; offset + 1 < digest.length; offset += 2) {
    ports.add(portBase + (digest.readUInt16BE(offset) % portSpan));
    if (ports.size === candidateCount) break;
  }

  for (const port of ports) {
    const server = await tryListen(port, handshake);
    if (server) return server;
    if (await probe(port, handshake, timeoutMs)) return null;
  }
  return null;
}
