#!/usr/bin/env node
/**
 * CLI entry point for npx / global install.
 *
 * Routes subcommands:
 *   (no args)  — start the bot (delegates to wrapper)
 *   init       — interactive .env setup
 *   --help     — print usage
 *   --version  — print package version
 *
 * Exports:
 *   None (side-effect: runs CLI).
 */

import { COMPACT_BOT_VERSION } from "./version.js";

function printHelp(): void {
  console.log(`Usage: compact-bot [command]

Commands:
  init                 Run interactive setup
  help, -h, --help     Show this help
  version, -v, --version
                       Show the installed version

With no command, Compact Bot starts using the configured agent and platforms.`);
}

const args = process.argv.slice(2);
const command = args[0];

if (args.length === 0) {
  await import("./wrapper.js");
} else if (
  args.length === 1 &&
  (command === "help" || command === "-h" || command === "--help")
) {
  printHelp();
} else if (
  args.length === 1 &&
  (command === "version" || command === "-v" || command === "--version")
) {
  console.log(COMPACT_BOT_VERSION);
} else if (args.length === 1 && command === "init") {
  const { runInit } = await import("./init.js");
  await runInit();
} else {
  const renderedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  console.error(`Unknown command or arguments: ${renderedArgs}`);
  console.error("Run compact-bot --help for usage.");
  process.exitCode = 1;
}
