import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("ARM64 离线打包脚本为 Linux 和 macOS 生成统一命名的可移动运行包", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-offline-package-"));
  const packageRoot = join(testRoot, "project");
  const scriptPath = resolve("scripts/package-offline-arm64.sh");

  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  for (const directory of [
    join(packageRoot, ".next"),
    join(packageRoot, "bin"),
    join(packageRoot, ".playwright-browsers", "chromium-1234"),
    join(packageRoot, ".playwright-browsers", "chromium_headless_shell-1234"),
    join(packageRoot, "node_modules", ".bin"),
    join(packageRoot, "node_modules", "next"),
    join(packageRoot, "public"),
    join(packageRoot, "scripts"),
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
  writeFileSync(join(packageRoot, ".playwright-browsers", "chromium-1234", "INSTALLATION_COMPLETE"), "fixture\n");
  writeFileSync(join(packageRoot, ".playwright-browsers", "chromium_headless_shell-1234", "INSTALLATION_COMPLETE"), "fixture\n");
  writeFileSync(join(packageRoot, "node_modules", ".bin", "playwright-cli"), "#!/bin/sh\n");
  writeFileSync(join(packageRoot, "node_modules", "next", "package.json"), "{}\n");
  writeFileSync(join(packageRoot, "scripts", "playwright-cli-wrapper.sh"), "#!/bin/sh\n");
  chmodSync(join(packageRoot, "scripts", "playwright-cli-wrapper.sh"), 0o755);

  const platforms = [
    {
      name: "linux",
      nodeDirectory: "node-v22.19.0-linux-arm64",
      expectedBundle: "pi-web-0.8.9-linux-arm64",
    },
    {
      name: "macos",
      nodeDirectory: "node-v22.19.0-darwin-arm64",
      expectedBundle: "pi-web-0.8.9-macos-arm64",
    },
  ];

  for (const platform of platforms) {
    const platformRoot = join(testRoot, platform.name);
    const nodeRoot = join(platformRoot, platform.nodeDirectory);
    const outputRoot = join(platformRoot, "output");
    const extractRoot = join(platformRoot, "extract");
    const capturePath = join(platformRoot, "launch.txt");
    mkdirSync(join(nodeRoot, "bin"), { recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(extractRoot, { recursive: true });

    writeFileSync(
      join(nodeRoot, "bin", "node"),
      [
        "#!/bin/sh",
        "printf 'cwd=%s\\n' \"$PWD\" > \"$PI_WEB_TEST_CAPTURE\"",
        "printf 'path=%s\\n' \"$PATH\" >> \"$PI_WEB_TEST_CAPTURE\"",
        "printf 'browsers=%s\\n' \"${PLAYWRIGHT_BROWSERS_PATH-}\" >> \"$PI_WEB_TEST_CAPTURE\"",
        "printf 'update-notifier=%s\\n' \"${NO_UPDATE_NOTIFIER-}\" >> \"$PI_WEB_TEST_CAPTURE\"",
        "for argument in \"$@\"; do printf 'arg=%s\\n' \"$argument\" >> \"$PI_WEB_TEST_CAPTURE\"; done",
        "",
      ].join("\n"),
    );
    chmodSync(join(nodeRoot, "bin", "node"), 0o755);

    const nodeArchive = join(platformRoot, `${platform.nodeDirectory}.tar.xz`);
    const archiveResult = spawnSync("tar", ["-cJf", nodeArchive, "-C", platformRoot, platform.nodeDirectory], {
      encoding: "utf8",
    });
    assert.equal(archiveResult.status, 0, archiveResult.stderr);

    const packageResult = spawnSync("bash", [scriptPath, platform.name, nodeArchive, outputRoot], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PI_WEB_BUILD_NODE: process.execPath,
        PI_WEB_PACKAGE_ROOT: packageRoot,
      },
    });
    assert.equal(packageResult.status, 0, packageResult.stderr);

    const offlineArchive = join(outputRoot, `${platform.expectedBundle}.tar.gz`);
    assert.equal(existsSync(offlineArchive), true);

    const extractResult = spawnSync("tar", ["-xzf", offlineArchive, "-C", extractRoot], { encoding: "utf8" });
    assert.equal(extractResult.status, 0, extractResult.stderr);

    const bundleRoot = join(extractRoot, platform.expectedBundle);
    for (const relativePath of [
      "app/.next/BUILD_ID",
      "app/bin/pi-web.js",
      "app/node_modules/.bin/playwright-cli",
      "app/node_modules/next/package.json",
      "app/public/offline.html",
      "app/package.json",
      "app/next.config.ts",
      "browsers/chromium-1234/INSTALLATION_COMPLETE",
      "browsers/chromium_headless_shell-1234/INSTALLATION_COMPLETE",
      "LICENSE",
      "runtime/bin/node",
      "runtime/bin/playwright-cli",
      "start.sh",
    ]) {
      assert.equal(existsSync(join(bundleRoot, relativePath)), true, `${platform.name}: ${relativePath} should exist`);
    }
    assert.notEqual(statSync(join(bundleRoot, "start.sh")).mode & 0o111, 0);
    assert.notEqual(statSync(join(bundleRoot, "runtime", "bin", "playwright-cli")).mode & 0o111, 0);

    const launchResult = spawnSync("bash", [join(bundleRoot, "start.sh"), "--port", "32000"], {
      cwd: testRoot,
      encoding: "utf8",
      env: { ...process.env, PI_WEB_TEST_CAPTURE: capturePath },
    });
    assert.equal(launchResult.status, 0, launchResult.stderr);
    const launchLines = readFileSync(capturePath, "utf8").trim().split("\n");
    const packagedPath = launchLines[1].slice("path=".length).split(":");
    assert.equal(launchLines[0], `cwd=${bundleRoot}`);
    assert.deepEqual(packagedPath.slice(0, 2), [
      join(bundleRoot, "runtime", "bin"),
      join(bundleRoot, "app", "node_modules", ".bin"),
    ]);
    assert.equal(launchLines[2], `browsers=${join(bundleRoot, "browsers")}`);
    assert.equal(launchLines[3], "update-notifier=1");
    assert.deepEqual(launchLines.slice(4), [
      "arg=./app/bin/pi-web.js",
      "arg=--no-open",
      "arg=--port",
      "arg=32000",
    ]);
  }
});

test("ARM64 离线打包脚本拒绝非标准平台名称", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-offline-platform-"));
  const nodeArchive = join(testRoot, "node.tar.xz");
  const scriptPath = resolve("scripts/package-offline-arm64.sh");
  writeFileSync(nodeArchive, "fixture");
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  const result = spawnSync("bash", [scriptPath, "darwin", nodeArchive, testRoot], {
    cwd: resolve("."),
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /不支持的目标平台: darwin/);
});
