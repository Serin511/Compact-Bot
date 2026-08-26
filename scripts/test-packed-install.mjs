#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(projectRoot, "package.json"), "utf8"),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoot = mkdtempSync(join(tmpdir(), "compact-bot-package-"));

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function testPackedSourceMaps(installedRoot) {
  const distRoot = join(installedRoot, "dist");
  const maps = walkFiles(distRoot).filter((path) => path.endsWith(".map"));
  if (maps.length === 0) throw new Error("packed artifact has no source maps");

  for (const mapPath of maps) {
    const sourceMap = JSON.parse(readFileSync(mapPath, "utf8"));
    if (mapPath.endsWith(".js.map")) {
      if (
        !Array.isArray(sourceMap.sourcesContent) ||
        sourceMap.sourcesContent.length !== sourceMap.sources?.length ||
        sourceMap.sourcesContent.some(
          (source) => typeof source !== "string" || source.length === 0,
        )
      ) {
        throw new Error(
          `packed JavaScript source map does not embed its TypeScript sources: ${
            relative(installedRoot, mapPath)
          }`,
        );
      }
      continue;
    }

    if (!mapPath.endsWith(".d.ts.map")) continue;
    if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
      throw new Error(
        `packed declaration map has no sources: ${
          relative(installedRoot, mapPath)
        }`,
      );
    }
    for (const source of sourceMap.sources) {
      if (typeof source !== "string") {
        throw new Error(`invalid declaration source in ${mapPath}`);
      }
      const sourcePath = resolve(dirname(mapPath), source);
      const relativeSource = relative(installedRoot, sourcePath);
      if (
        relativeSource.startsWith("..") ||
        isAbsolute(relativeSource) ||
        !existsSync(sourcePath)
      ) {
        throw new Error(
          `packed declaration source is missing: ${relativeSource}`,
        );
      }
    }
  }
}

async function testPty(installedRoot) {
  const require = createRequire(join(installedRoot, "package.json"));
  const pty = require("node-pty");
  const marker = "COMPACT_BOT_PACKED_PTY_OK";

  await new Promise((resolvePromise, reject) => {
    let output = "";
    const child = pty.spawn(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(marker)})`],
      {
        name: "xterm-color",
        cols: 80,
        rows: 30,
        cwd: installedRoot,
        env: process.env,
      },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("packed node-pty smoke test timed out"));
    }, 10_000);

    child.onData((data) => {
      output += data;
    });
    child.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes(marker)) {
        reject(
          new Error(
            `packed node-pty smoke test failed (exit ${exitCode}): ${output}`,
          ),
        );
        return;
      }
      resolvePromise();
    });
  });
}

function testNestedMcpResolution(tarball, installFixture) {
  mkdirSync(installFixture);
  writeFileSync(
    join(installFixture, "package.json"),
    JSON.stringify({ private: true }),
  );
  run(
    npm,
    [
      "install",
      "--install-strategy=nested",
      "--no-audit",
      "--no-fund",
      tarball,
    ],
    installFixture,
  );

  const installedRoot = join(
    installFixture,
    "node_modules",
    "@serin511",
    "compact-bot",
  );
  for (const entrypoint of ["mcp-server.js", "slack-mcp-server.js"]) {
    const result = spawnSync(
      process.execPath,
      [join(installedRoot, "dist", entrypoint)],
      {
        cwd: installFixture,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(installFixture, "xdg"),
          AGENT_PROVIDER: "codex",
          WRAPPER_SOCKET: join(installFixture, "missing-wrapper.sock"),
          COMPACT_BOT_IPC_AUTH_TOKEN: "nested-import-probe",
          DISCORD_BOT_TOKEN: "discord-import-probe",
          SLACK_BOT_TOKEN: "xoxb-import-probe",
          SLACK_APP_TOKEN: "xapp-import-probe",
        },
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (
      result.status === 0 ||
      !output.includes("Codex mode requires wrapper IPC")
    ) {
      throw new Error(
        `nested packed ${entrypoint} import failed: ${
          result.error?.message ?? output
        }`,
      );
    }
  }
}

try {
  const cleanSource = join(tempRoot, "source");
  const packDestination = join(tempRoot, "tarball");
  const installFixture = join(tempRoot, "install");
  const nestedInstallFixture = join(tempRoot, "nested-install");
  mkdirSync(cleanSource);
  mkdirSync(packDestination);
  mkdirSync(installFixture);

  for (const entry of [
    ".env.example",
    ".gitignore",
    "LICENSE",
    "README.md",
    "package-lock.json",
    "package.json",
    "scripts",
    "src",
    "tsconfig.json",
  ]) {
    cpSync(join(projectRoot, entry), join(cleanSource, entry), {
      recursive: true,
    });
  }

  // A stale build product must never survive prepare into a release tarball.
  mkdirSync(join(cleanSource, "dist"));
  writeFileSync(
    join(cleanSource, "dist", "stale-release-artifact.js"),
    "throw new Error('stale artifact was packed');\n",
  );

  // Keep the source fixture clean (no dist) while reusing the already installed
  // build toolchain. `npm pack` must run `prepare` and create dist itself.
  symlinkSync(join(projectRoot, "node_modules"), join(cleanSource, "node_modules"));
  const packedName = run(
    npm,
    ["pack", "--silent", "--pack-destination", packDestination],
    cleanSource,
  )
    .trim()
    .split(/\r?\n/)
    .at(-1);
  if (!packedName) throw new Error("npm pack did not return a tarball name");

  const tarball = join(packDestination, basename(packedName));
  writeFileSync(
    join(installFixture, "package.json"),
    JSON.stringify({ private: true }),
  );
  run(
    npm,
    ["install", "--no-audit", "--no-fund", tarball],
    installFixture,
  );

  const installedRoot = join(
    installFixture,
    "node_modules",
    "@serin511",
    "compact-bot",
  );
  for (const requiredPath of [
    "LICENSE",
    "dist/claude-mcp-proxy.js",
    "dist/claude-mcp-relay.js",
    "dist/cli.js",
    "dist/cli.d.ts.map",
    "dist/mcp-runtime-environment.js",
    "dist/wrapper.js",
    "src/cli.ts",
    "scripts/clean-dist.mjs",
    "scripts/fix-node-pty-permissions.mjs",
  ]) {
    if (!existsSync(join(installedRoot, requiredPath))) {
      throw new Error(`packed artifact is missing ${requiredPath}`);
    }
  }
  if (existsSync(join(installedRoot, "dist", "stale-release-artifact.js"))) {
    throw new Error("prepare did not remove a stale dist artifact");
  }
  testPackedSourceMaps(installedRoot);

  if (process.platform === "darwin") {
    const require = createRequire(join(installedRoot, "package.json"));
    const nodePtyRoot = dirname(require.resolve("node-pty/package.json"));
    const helper = [
      join(
        nodePtyRoot,
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      ),
      join(nodePtyRoot, "build", "Release", "spawn-helper"),
    ].find((candidate) => existsSync(candidate));
    if (!helper) {
      throw new Error(`packed node-pty spawn-helper is missing under ${nodePtyRoot}`);
    }
    if ((statSync(helper).mode & 0o111) === 0) {
      throw new Error(`packed spawn-helper is not executable: ${helper}`);
    }
  }

  const versionResult = spawnSync(
    join(
      installFixture,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "compact-bot.cmd" : "compact-bot",
    ),
    ["--version"],
    { encoding: "utf8" },
  );
  if (
    versionResult.status !== 0 ||
    versionResult.stdout.trim() !== packageJson.version
  ) {
    throw new Error(
      `packed CLI version check failed: ${versionResult.stderr || versionResult.stdout}`,
    );
  }

  await testPty(installedRoot);
  testNestedMcpResolution(tarball, nestedInstallFixture);
  console.log(
    `Packed install verified: @serin511/compact-bot ${packageJson.version}`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
