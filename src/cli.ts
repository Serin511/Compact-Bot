#!/usr/bin/env node
/**
 * CLI entry point for npx / global install.
 *
 * Routes subcommands:
 *   (no args)  — start the bot (delegates to wrapper)
 *   init       — interactive .env setup
 *
 * Exports:
 *   None (side-effect: runs CLI).
 */

const command = process.argv[2];

if (command === "init") {
  const { runInit } = await import("./init.js");
  await runInit();
} else {
  await import("./wrapper.js");
}
