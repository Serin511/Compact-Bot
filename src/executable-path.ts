/**
 * Resolve command names from PATH without invoking a shell or external
 * `which` binary.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import {
  delimiter,
  isAbsolute,
  join,
  resolve,
} from "node:path";

export function isExecutableFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CodexExecutableOptions {
  pathValue?: string;
  cwd?: string;
  home?: string;
  appCandidates?: readonly string[];
  validate?: (candidate: string) => boolean;
}

/** Verify that a candidate can run the exact Codex app-server subcommand. */
export function isWorkingCodexExecutable(candidate: string): boolean {
  if (!isExecutableFile(candidate)) return false;
  try {
    execFileSync(candidate, ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    execFileSync(candidate, ["app-server", "--help"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the first executable matching a bare command name in PATH.
 *
 * Explicit paths are intentionally rejected; callers should validate those
 * directly so a malformed command cannot be interpreted by a shell.
 */
export function executableOnPath(
  command: string,
  pathValue = process.env.PATH ?? "",
  cwd = process.cwd(),
): string | null {
  return executableCandidatesOnPath(command, pathValue, cwd)[0] ?? null;
}

/**
 * Return every executable matching a bare command name, in PATH order.
 *
 * Codex resolution validates each candidate because an executable shim can
 * exist yet fail to launch its underlying binary.
 */
function executableCandidatesOnPath(
  command: string,
  pathValue = process.env.PATH ?? "",
  cwd = process.cwd(),
): string[] {
  if (
    !command ||
    command.includes("\0") ||
    command.includes("/") ||
    command.includes("\\")
  ) {
    return [];
  }

  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];
  const candidates: string[] = [];
  for (const entry of pathValue.split(delimiter)) {
    const root = entry
      ? (isAbsolute(entry) ? entry : resolve(cwd, entry))
      : cwd;
    for (const extension of extensions) {
      const candidate = join(root, `${command}${extension}`);
      if (isExecutableFile(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

/**
 * Resolve a functional Codex app-server executable.
 *
 * A broken npm shim on PATH is skipped in favour of the desktop app bundles.
 * An explicit CODEX_PATH remains authoritative and fails closed when invalid.
 */
export function resolveCodexExecutable(
  configured: string,
  options: CodexExecutableOptions = {},
): string | null {
  const validate = options.validate ?? isWorkingCodexExecutable;
  if (configured.includes("/") || configured.includes("\\")) {
    // Validation happens in Compact Bot's launch directory, but Codex is
    // spawned with the agent's DEFAULT_CWD. Freeze an explicit relative path
    // here so changing the child cwd cannot turn a valid path into ENOENT.
    const explicit = isAbsolute(configured)
      ? configured
      : resolve(options.cwd ?? process.cwd(), configured);
    return validate(explicit) ? explicit : null;
  }

  const pathCandidates = executableCandidatesOnPath(
    configured,
    options.pathValue ?? process.env.PATH,
    options.cwd,
  );
  for (const candidate of pathCandidates) {
    if (validate(candidate)) return candidate;
  }

  const home = options.home ?? process.env.HOME ?? "";
  const appCandidates = options.appCandidates ?? [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    ...(home
      ? [
          join(home, "Applications/Codex.app/Contents/Resources/codex"),
          join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
        ]
      : []),
  ];
  return appCandidates.find((candidate) => validate(candidate)) ?? null;
}
