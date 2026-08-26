#!/usr/bin/env node

import { rmSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distPath = join(projectRoot, "dist");
const parsed = parse(distPath);

if (
  parsed.root === distPath ||
  dirname(distPath) !== projectRoot ||
  parsed.base !== "dist"
) {
  throw new Error(`Refusing to clean unexpected build path: ${distPath}`);
}

rmSync(distPath, { recursive: true, force: true });
