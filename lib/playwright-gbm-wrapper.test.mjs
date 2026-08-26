import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const wrapperSourcePath = resolve("scripts/playwright-cli-wrapper.sh");

/**
 * 创建一个可执行包装器、Chromium 和真实 CLI 的隔离离线包夹具。
 *
 * @param {import("node:test").TestContext} testContext 当前测试上下文，用于注册临时目录清理。
 * @returns {{ bundleRoot: string, capturePath: string, candidatePath: string, commandPath: string }} 测试启动所需路径。
 */
function createWrapperFixture(testContext) {
  assert.equal(existsSync(wrapperSourcePath), true, "缺少 Playwright Chromium 兼容包装器");

  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-playwright-gbm-"));
  const bundleRoot = join(testRoot, "pi-web-linux-arm64");
  const wrapperPath = join(bundleRoot, "runtime", "bin", "playwright-cli");
  const realCliPath = join(bundleRoot, "app", "node_modules", ".bin", "playwright-cli");
  const browserPath = join(bundleRoot, "browsers", "chromium-1234", "chrome-linux", "chrome");
  const headlessShellPath = join(
    bundleRoot,
    "browsers",
    "chromium_headless_shell-1234",
    "chrome-linux",
    "headless_shell",
  );
  const commandPath = join(testRoot, "commands");
  const capturePath = join(testRoot, "cli-environment.txt");
  const candidatePath = join(testRoot, "mesa", "libgbm.so.1");

  testContext.after(() => rmSync(testRoot, { recursive: true, force: true }));
  for (const directory of [
    join(bundleRoot, "runtime", "bin"),
    join(bundleRoot, "app", "node_modules", ".bin"),
    join(bundleRoot, "browsers", "chromium-1234", "chrome-linux"),
    join(bundleRoot, "browsers", "chromium_headless_shell-1234", "chrome-linux"),
    commandPath,
    join(testRoot, "mesa"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  copyFileSync(wrapperSourcePath, wrapperPath);
  chmodSync(wrapperPath, 0o755);
  writeFileSync(candidatePath, "test fixture\n");

  writeFileSync(
    join(commandPath, "uname"),
    [
      "#!/bin/sh",
      "case \"$1\" in",
      "  -s) printf 'Linux\\n' ;;",
      "  -m) printf 'aarch64\\n' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(commandPath, "uname"), 0o755);

  writeFileSync(
    join(commandPath, "ldconfig"),
    [
      "#!/bin/sh",
      "printf 'libgbm.so.1 (libc6,AArch64) => %s\\n' \"$PI_WEB_TEST_GBM_CANDIDATE\"",
      "",
    ].join("\n"),
  );
  chmodSync(join(commandPath, "ldconfig"), 0o755);

  writeFileSync(
    browserPath,
    "#!/bin/sh\nprintf 'Chromium test\\n'\n",
  );
  chmodSync(browserPath, 0o755);

  writeFileSync(
    headlessShellPath,
    [
      "#!/bin/sh",
      "case \"$PI_WEB_TEST_BROWSER_MODE\" in",
      "  healthy)",
      "    printf 'Chromium test\\n'",
      "    exit 0",
      "    ;;",
      "  missing-symbol)",
      "    case \"${LD_PRELOAD-}\" in",
      "      \"$PI_WEB_TEST_GBM_CANDIDATE\"|\"$PI_WEB_TEST_GBM_CANDIDATE\":*) exit 0 ;;",
      "    esac",
      "    printf 'chrome: symbol lookup error: undefined symbol: gbm_bo_map\\n' >&2",
      "    exit 127",
      "    ;;",
      "  invalid-fallback)",
      "    printf 'chrome: symbol lookup error: undefined symbol: gbm_bo_unmap\\n' >&2",
      "    exit 127",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(headlessShellPath, 0o755);

  writeFileSync(
    realCliPath,
    [
      "#!/bin/sh",
      "printf 'browser=%s\\n' \"${PLAYWRIGHT_MCP_BROWSER-}\" > \"$PI_WEB_TEST_CAPTURE\"",
      "printf 'preload=%s\\n' \"${LD_PRELOAD-}\" >> \"$PI_WEB_TEST_CAPTURE\"",
      "for argument in \"$@\"; do printf 'arg=%s\\n' \"$argument\" >> \"$PI_WEB_TEST_CAPTURE\"; done",
      "",
    ].join("\n"),
  );
  chmodSync(realCliPath, 0o755);

  return { bundleRoot, capturePath, candidatePath, commandPath };
}

/**
 * 执行夹具中的包装器并返回子进程结果。
 *
 * @param {ReturnType<typeof createWrapperFixture>} fixture 离线包测试夹具。
 * @param {"healthy" | "missing-symbol" | "invalid-fallback"} browserMode Chromium 探测行为。
 * @param {string | undefined} browserName 显式浏览器选择；未提供时模拟干净离线环境。
 * @returns {ReturnType<typeof spawnSync>} 包装器子进程结果。
 */
function runWrapper(fixture, browserMode, browserName) {
  const environment = {
    ...process.env,
    PATH: `${fixture.commandPath}:${process.env.PATH ?? ""}`,
    PLAYWRIGHT_BROWSERS_PATH: join(fixture.bundleRoot, "browsers"),
    PI_WEB_TEST_BROWSER_MODE: browserMode,
    PI_WEB_TEST_CAPTURE: fixture.capturePath,
    PI_WEB_TEST_GBM_CANDIDATE: fixture.candidatePath,
  };
  delete environment.LD_PRELOAD;
  delete environment.PLAYWRIGHT_MCP_BROWSER;
  if (browserName !== undefined) {
    environment.PLAYWRIGHT_MCP_BROWSER = browserName;
  }

  return spawnSync(
    join(fixture.bundleRoot, "runtime", "bin", "playwright-cli"),
    ["-s=offline-test", "open", "about:blank"],
    { encoding: "utf8", env: environment },
  );
}

test("Playwright 包装器默认让真实 CLI 使用离线 Chromium", (testContext) => {
  const fixture = createWrapperFixture(testContext);

  const result = runWrapper(fixture, "healthy");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.capturePath, "utf8").trim().split("\n"), [
    "browser=chromium",
    "preload=",
    "arg=-s=offline-test",
    "arg=open",
    "arg=about:blank",
  ]);
});

test("Playwright 包装器保留显式浏览器选择", (testContext) => {
  const fixture = createWrapperFixture(testContext);

  const result = runWrapper(fixture, "healthy", "firefox");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(fixture.capturePath, "utf8").split("\n")[0], "browser=firefox");
});

test("Playwright 包装器在 Chromium 默认可启动时不注入 GBM 库", (testContext) => {
  const fixture = createWrapperFixture(testContext);

  const result = runWrapper(fixture, "healthy");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.capturePath, "utf8").trim().split("\n"), [
    "browser=chromium",
    "preload=",
    "arg=-s=offline-test",
    "arg=open",
    "arg=about:blank",
  ]);
  assert.doesNotMatch(result.stderr, /libgbm/);
});

test("Playwright 包装器在 Chromium 缺少 GBM 符号时自动回退 Mesa 库", (testContext) => {
  const fixture = createWrapperFixture(testContext);

  const result = runWrapper(fixture, "missing-symbol");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.capturePath, "utf8").trim().split("\n"), [
    "browser=chromium",
    `preload=${fixture.candidatePath}`,
    "arg=-s=offline-test",
    "arg=open",
    "arg=about:blank",
  ]);
  assert.match(result.stderr, /已为 Chromium 选择兼容的 libgbm/);
});

test("Playwright 包装器找不到兼容 GBM 库时不污染真实 CLI 环境", (testContext) => {
  const fixture = createWrapperFixture(testContext);

  const result = runWrapper(fixture, "invalid-fallback");

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(fixture.capturePath, "utf8").split("\n").slice(0, 2), [
    "browser=chromium",
    "preload=",
  ]);
  assert.match(result.stderr, /未找到可兼容 Chromium 的 libgbm/);
});
