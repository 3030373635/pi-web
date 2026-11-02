import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { load as loadYaml } from "js-yaml";

const packageScript = path.resolve("scripts/package-offline-windows-x64.mjs");

/**
 * 创建 Windows 离线包测试所需的最小应用目录。
 * @param {string} packageRoot 模拟的 Pi Web 项目根目录。
 */
async function createPackageFixture(packageRoot) {
  const directories = [
    ".next/cache",
    ".next/server",
    ".playwright-browsers/chromium-123",
    ".playwright-browsers/chromium_headless_shell-123",
    "bin",
    "node_modules/.bin",
    "public",
  ];
  await Promise.all(directories.map((directory) => mkdir(path.join(packageRoot, directory), { recursive: true })));

  const files = new Map([
    [".next/cache/stale.txt", "cache"],
    [".next/server/app.js", "server"],
    [".playwright-browsers/chromium-123/chrome.exe", "browser"],
    [".playwright-browsers/chromium_headless_shell-123/headless_shell.exe", "headless"],
    ["bin/pi-web.js", "entry"],
    ["node_modules/.bin/playwright-cli.cmd", "@echo off"],
    ["public/favicon.ico", "icon"],
    ["package.json", JSON.stringify({ name: "@agegr/pi-web", version: "1.2.3" })],
    ["next.config.ts", "export default {};"],
    ["LICENSE", "MIT"],
  ]);
  await Promise.all([...files].map(([file, content]) => writeFile(path.join(packageRoot, file), content)));
}

test("stages a movable Windows x64 offline package", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-windows-package-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));

  const packageRoot = path.join(temporaryRoot, "source");
  const runtimeRoot = path.join(temporaryRoot, "node-runtime");
  const outputRoot = path.join(temporaryRoot, "dist");
  await createPackageFixture(packageRoot);
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(path.join(runtimeRoot, "node.exe"), "portable node");
  await writeFile(path.join(runtimeRoot, "npm.cmd"), "portable npm");

  const stdout = execFileSync(
    process.execPath,
    [
      packageScript,
      "--package-root",
      packageRoot,
      "--runtime-root",
      runtimeRoot,
      "--output-root",
      outputRoot,
    ],
    { encoding: "utf8" },
  );

  const bundleRoot = path.join(outputRoot, "pi-web-1.2.3-windows-x64");
  assert.equal(stdout.trim(), bundleRoot);
  assert.equal(await readFile(path.join(bundleRoot, "app/.next/server/app.js"), "utf8"), "server");
  assert.equal(await readFile(path.join(bundleRoot, "runtime/node.exe"), "utf8"), "portable node");
  assert.equal(await readFile(path.join(bundleRoot, "browsers/chromium-123/chrome.exe"), "utf8"), "browser");
  assert.equal(existsSync(path.join(bundleRoot, "app/.next/cache")), false);
  assert.equal(existsSync(path.join(bundleRoot, "start.cmd")), true);
  const playwrightLauncher = await readFile(path.join(bundleRoot, "runtime/playwright-cli.cmd"), "utf8");
  assert.match(
    playwrightLauncher,
    /if not defined PLAYWRIGHT_MCP_BROWSER set "PLAYWRIGHT_MCP_BROWSER=chromium"/,
    "the wrapper defaults to bundled Chromium without replacing an explicit browser choice",
  );
});

test("routes the Windows 10 package workflow through a hosted x64 Windows action", async () => {
  const workflow = loadYaml(await readFile(".github/workflows/offline-windows-x64.yml", "utf8"));
  const buildJob = workflow.jobs["build-offline-package"];

  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.equal(buildJob["runs-on"], "windows-2022");
  assert.equal(buildJob.steps[0].uses, "actions/checkout@v5");
  assert.equal(buildJob.steps[1].uses, "./.github/actions/build-offline-windows-x64");
});

test("runs only Windows package tests in the Windows packaging action", async () => {
  const action = loadYaml(await readFile(".github/actions/build-offline-windows-x64/action.yml", "utf8"));
  const testStep = action.runs.steps.find((step) => step.name === "Run Windows package tests");

  assert.equal(testStep?.shell, "pwsh");
  assert.equal(testStep?.run, "node --test lib/offline-windows-package.test.mjs");
});
