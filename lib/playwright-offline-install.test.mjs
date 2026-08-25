import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Playwright 离线安装脚本为 macOS 和 Linux 下载完整 Chromium", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-playwright-install-"));
  const packageRoot = join(testRoot, "project");
  const cliPath = join(packageRoot, "node_modules", ".bin", "playwright-cli");
  const scriptPath = resolve("scripts/install-playwright-browser.sh");

  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  mkdirSync(join(packageRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    cliPath,
    [
      "#!/bin/sh",
      "printf 'browsers=%s\\n' \"${PLAYWRIGHT_BROWSERS_PATH-}\" > \"$PI_WEB_TEST_CAPTURE\"",
      "for argument in \"$@\"; do printf 'arg=%s\\n' \"$argument\" >> \"$PI_WEB_TEST_CAPTURE\"; done",
      "mkdir -p \"$PLAYWRIGHT_BROWSERS_PATH/chromium-1234\"",
      "mkdir -p \"$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1234\"",
      "",
    ].join("\n"),
  );
  chmodSync(cliPath, 0o755);

  const platforms = [
    {
      name: "macos",
      expectedArguments: ["arg=install-browser", "arg=chromium"],
    },
    {
      name: "linux",
      expectedArguments: ["arg=install-browser", "arg=chromium", "arg=--with-deps"],
    },
  ];

  for (const platform of platforms) {
    const browserRoot = join(testRoot, platform.name, "browsers");
    const capturePath = join(testRoot, platform.name, "install.txt");
    mkdirSync(join(testRoot, platform.name), { recursive: true });

    const result = spawnSync("bash", [scriptPath, platform.name, browserRoot], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PI_WEB_PACKAGE_ROOT: packageRoot,
        PI_WEB_TEST_CAPTURE: capturePath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(capturePath, "utf8").trim().split("\n"), [
      `browsers=${browserRoot}`,
      ...platform.expectedArguments,
    ]);
  }
});

test("Playwright 离线安装脚本拒绝缺少有头 Chromium 的下载结果", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-playwright-incomplete-"));
  const packageRoot = join(testRoot, "project");
  const cliPath = join(packageRoot, "node_modules", ".bin", "playwright-cli");
  const browserRoot = join(testRoot, "browsers");
  const scriptPath = resolve("scripts/install-playwright-browser.sh");

  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  mkdirSync(join(packageRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    cliPath,
    "#!/bin/sh\nmkdir -p \"$PLAYWRIGHT_BROWSERS_PATH/chromium_headless_shell-1234\"\n",
  );
  chmodSync(cliPath, 0o755);

  const result = spawnSync("bash", [scriptPath, "macos", browserRoot], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, PI_WEB_PACKAGE_ROOT: packageRoot },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少完整 Chromium/);
});

test("Playwright 离线安装脚本拒绝缺少 Chromium 无头 shell 的下载结果", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-playwright-no-shell-"));
  const packageRoot = join(testRoot, "project");
  const cliPath = join(packageRoot, "node_modules", ".bin", "playwright-cli");
  const browserRoot = join(testRoot, "browsers");
  const scriptPath = resolve("scripts/install-playwright-browser.sh");

  t.after(() => rmSync(testRoot, { recursive: true, force: true }));
  mkdirSync(join(packageRoot, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    cliPath,
    "#!/bin/sh\nmkdir -p \"$PLAYWRIGHT_BROWSERS_PATH/chromium-1234\"\n",
  );
  chmodSync(cliPath, 0o755);

  const result = spawnSync("bash", [scriptPath, "macos", browserRoot], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, PI_WEB_PACKAGE_ROOT: packageRoot },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /缺少 Chromium 无头 shell/);
});

test("Playwright 离线安装脚本拒绝非标准平台名称", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-playwright-platform-"));
  const scriptPath = resolve("scripts/install-playwright-browser.sh");
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  const result = spawnSync("bash", [scriptPath, "darwin", join(testRoot, "browsers")], {
    cwd: resolve("."),
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /不支持的目标平台: darwin/);
});
