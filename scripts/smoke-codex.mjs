#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CodexAppServer } from "../dist/codex-app-server.js";
import { resolveCodexExecutable } from "../dist/executable-path.js";
import { buildCodexAppServerEnvironment } from "../dist/runtime-coordination.js";

function stringEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );
}

function waitForTurnCompletion(backend, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Codex smoke turn timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onNotification = ({ method, params }) => {
      if (method !== "turn/completed") return;
      clearTimeout(timer);
      backend.off("notification", onNotification);
      resolve(params);
    };
    backend.on("notification", onNotification);
  });
}

const executable = resolveCodexExecutable(process.env.CODEX_PATH || "codex");
if (!executable) {
  console.error("Codex executable not found. Set CODEX_PATH or install Codex.");
  process.exit(1);
}

const cwd = mkdtempSync(join(tmpdir(), "compact-bot-codex-smoke-"));
const marker =
  process.env.CODEX_SMOKE_MARKER ||
  `COMPACT_BOT_SYSTEM_PROMPT_${randomUUID().replaceAll("-", "")}`;
const model = process.env.CODEX_SMOKE_MODEL || "gpt-5.6-sol";
const effort = process.env.CODEX_SMOKE_EFFORT || "ultra";
const ipcCanary =
  `COMPACT_BOT_IPC_CANARY_${randomUUID().replaceAll("-", "")}`;
const appServerEnv = buildCodexAppServerEnvironment({
  ...stringEnv(),
  COMPACT_BOT_IPC_AUTH_TOKEN: ipcCanary,
  DISCORD_BOT_TOKEN: `discord-${ipcCanary}`,
  SLACK_BOT_TOKEN: `slack-${ipcCanary}`,
  SLACK_APP_TOKEN: `slack-app-${ipcCanary}`,
  WRAPPER_SOCKET: join(cwd, "must-not-be-inherited.sock"),
});
if (
  "COMPACT_BOT_IPC_AUTH_TOKEN" in appServerEnv ||
  "DISCORD_BOT_TOKEN" in appServerEnv ||
  "SLACK_BOT_TOKEN" in appServerEnv ||
  "SLACK_APP_TOKEN" in appServerEnv ||
  "WRAPPER_SOCKET" in appServerEnv
) {
  throw new Error("Codex app-server environment retained platform secrets");
}
const backend = new CodexAppServer({
  executable,
  cwd,
  model,
  effort,
  dangerouslySkipPermissions: false,
  developerInstructions: [
    "This is an automated Compact Bot protocol smoke test.",
    `The private verification marker is ${marker}.`,
    "When asked for it, respond with that marker exactly and nothing else.",
  ].join("\n"),
  mcpServers: [],
  env: appServerEnv,
  onQuestion: async () => null,
  onDebug: (message) => {
    if (process.env.VERBOSE === "true") console.error(message);
  },
  onError: (message, error) => {
    console.error(message, error ?? "");
  },
});

try {
  await backend.start();
  const completion = waitForTurnCompletion(backend, 120_000);
  await backend.submitText(
    "Return the private verification marker from your developer instructions. Output only the marker.",
  );
  const completed = await completion;
  if (completed?.turn?.status !== "completed") {
    throw new Error(
      `Codex smoke turn did not complete successfully: ${JSON.stringify(completed?.turn ?? completed)}`,
    );
  }

  const capture = await backend.captureStatus(true);
  const viewportCapture = await backend.captureStatus(false);
  if (!capture.includes(marker)) {
    throw new Error(
      "Codex transcript did not contain the developer-instruction marker",
    );
  }
  if (backend.currentEffort !== effort) {
    throw new Error(
      `Codex effort mismatch: expected ${effort}, got ${backend.currentEffort || "default"}`,
    );
  }

  // Exercise the same persisted thread mutation used by the chat `/effort`
  // command. Prefer a different supported value, then restore the requested
  // value so this also checks `ultra` when it is the smoke-test default.
  const alternateEffort = backend.availableEfforts.find(
    (candidate) => candidate !== effort,
  );
  if (alternateEffort) {
    await backend.setEffort(alternateEffort);
    if (backend.currentEffort !== alternateEffort) {
      throw new Error(
        `Codex effort update mismatch: expected ${alternateEffort}, got ${
          backend.currentEffort || "default"
        }`,
      );
    }
  }
  await backend.setEffort(effort);
  if (backend.currentEffort !== effort) {
    throw new Error(
      `Codex effort restore mismatch: expected ${effort}, got ${
        backend.currentEffort || "default"
      }`,
    );
  }

  if (!capture.includes("ASSISTANT")) {
    throw new Error("Codex capture did not render an assistant transcript item");
  }
  if (!viewportCapture.includes(marker)) {
    throw new Error("Codex viewport capture omitted the latest final answer");
  }

  const envCompletion = waitForTurnCompletion(backend, 120_000);
  await backend.submitText(
    "Use the shell to run `printenv COMPACT_BOT_IPC_AUTH_TOKEN`. " +
      "If the command prints no value, answer exactly ENV_CANARY_ABSENT. " +
      "Never invent a value.",
  );
  const envCompleted = await envCompletion;
  if (envCompleted?.turn?.status !== "completed") {
    throw new Error(
      `Codex env smoke turn failed: ${JSON.stringify(envCompleted?.turn ?? envCompleted)}`,
    );
  }
  const envCapture = await backend.captureStatus(true);
  if (!envCapture.includes("ENV_CANARY_ABSENT")) {
    throw new Error("Codex did not confirm the IPC canary was absent");
  }
  if (envCapture.includes(ipcCanary)) {
    throw new Error("Codex model shell exposed the IPC canary");
  }

  console.log(
    `Codex smoke passed: model=${backend.currentModel || model} effort=${backend.currentEffort} marker=${marker}`,
  );
} finally {
  await backend.stop().catch(() => {});
  rmSync(cwd, { recursive: true, force: true });
}
