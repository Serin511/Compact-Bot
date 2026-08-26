#!/usr/bin/env node

import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export function resolveNodePtyPackageRoot(resolveFrom = import.meta.url) {
  const require = createRequire(resolveFrom);
  return dirname(require.resolve("node-pty/package.json"));
}

export function ensureNodePtySpawnHelperExecutable({
  packageRoot = resolveNodePtyPackageRoot(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "darwin") return null;

  const candidates = [
    join(packageRoot, "prebuilds", `${platform}-${arch}`, "spawn-helper"),
    join(packageRoot, "build", "Release", "spawn-helper"),
  ];
  const helperPath = candidates.find((candidate) => existsSync(candidate));

  if (!helperPath) {
    throw new Error(
      `node-pty spawn-helper was not found for ${platform}-${arch}. Checked: ${candidates.join(", ")}`,
    );
  }

  chmodSync(helperPath, 0o755);
  if ((statSync(helperPath).mode & 0o111) === 0) {
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}`);
  }
  return helperPath;
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(process.argv[1]).href,
  );
}

if (isMainModule()) {
  try {
    const helperPath = ensureNodePtySpawnHelperExecutable();
    if (helperPath) {
      console.log(`compact-bot: enabled node-pty spawn-helper: ${helperPath}`);
    }
  } catch (error) {
    console.error(
      `compact-bot: failed to prepare node-pty: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
