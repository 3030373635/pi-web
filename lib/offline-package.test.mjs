import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("ARM64 离线打包脚本生成可移动且自带 Node 的运行包", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-offline-package-"));
  const packageRoot = join(testRoot, "project");
  const nodeRoot = join(testRoot, "node-v22.19.0-linux-arm64");
  const outputRoot = join(testRoot, "output");
  const extractRoot = join(testRoot, "extract");
  const capturePath = join(testRoot, "launch.txt");
  const scriptPath = resolve("scripts/package-offline-linux-arm64.sh");

  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  for (const directory of [
    join(packageRoot, ".next"),
    join(packageRoot, "bin"),
    join(packageRoot, "node_modules", "next"),
    join(packageRoot, "public"),
    join(nodeRoot, "bin"),
    outputRoot,
    extractRoot,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    version: "0.8.9",
    metadata: { version: "fixture-metadata-version" },
  }));
  writeFileSync(join(packageRoot, "next.config.ts"), "export default {};\n");
  writeFileSync(join(packageRoot, "LICENSE"), "MIT\n");
  writeFileSync(join(packageRoot, ".next", "BUILD_ID"), "fixture-build\n");
  writeFileSync(join(packageRoot, "public", "offline.html"), "offline\n");
  writeFileSync(join(packageRoot, "bin", "pi-web.js"), "console.log('fixture');\n");
  writeFileSync(join(packageRoot, "node_modules", "next", "package.json"), "{}\n");
  writeFileSync(
    join(nodeRoot, "bin", "node"),
    "#!/bin/sh\nprintf '%s\\n' \"$PWD\" > \"$PI_WEB_TEST_CAPTURE\"\nprintf '%s\\n' \"$@\" >> \"$PI_WEB_TEST_CAPTURE\"\n",
  );
  chmodSync(join(nodeRoot, "bin", "node"), 0o755);

  const nodeArchive = join(testRoot, "node-v22.19.0-linux-arm64.tar.xz");
  const archiveResult = spawnSync("tar", ["-cJf", nodeArchive, "-C", testRoot, "node-v22.19.0-linux-arm64"], {
    encoding: "utf8",
  });
  assert.equal(archiveResult.status, 0, archiveResult.stderr);

  const packageResult = spawnSync("bash", [scriptPath, nodeArchive, outputRoot], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      PI_WEB_BUILD_NODE: process.execPath,
      PI_WEB_PACKAGE_ROOT: packageRoot,
    },
  });
  assert.equal(packageResult.status, 0, packageResult.stderr);

  const offlineArchive = join(outputRoot, "pi-web-0.8.9-linux-arm64.tar.gz");
  assert.equal(existsSync(offlineArchive), true);

  const extractResult = spawnSync("tar", ["-xzf", offlineArchive, "-C", extractRoot], { encoding: "utf8" });
  assert.equal(extractResult.status, 0, extractResult.stderr);

  const bundleRoot = join(extractRoot, "pi-web-0.8.9-linux-arm64");
  for (const relativePath of [
    "app/.next/BUILD_ID",
    "app/bin/pi-web.js",
    "app/node_modules/next/package.json",
    "app/public/offline.html",
    "app/package.json",
    "app/next.config.ts",
    "LICENSE",
    "runtime/bin/node",
    "start.sh",
  ]) {
    assert.equal(existsSync(join(bundleRoot, relativePath)), true, `${relativePath} should exist`);
  }
  assert.notEqual(statSync(join(bundleRoot, "start.sh")).mode & 0o111, 0);

  const launchResult = spawnSync("bash", [join(bundleRoot, "start.sh"), "--port", "32000"], {
    cwd: testRoot,
    encoding: "utf8",
    env: { ...process.env, PI_WEB_TEST_CAPTURE: capturePath },
  });
  assert.equal(launchResult.status, 0, launchResult.stderr);
  assert.deepEqual(readFileSync(capturePath, "utf8").trim().split("\n"), [
    bundleRoot,
    "./app/bin/pi-web.js",
    "--no-open",
    "--port",
    "32000",
  ]);
});
