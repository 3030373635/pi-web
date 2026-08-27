import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Python 运行时安装脚本按 GLIBC 2.31 下载 wheel 并收集完整许可证", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-python-runtime-install-"));
  const archiveRoot = join(testRoot, "archive");
  const pythonRoot = join(archiveRoot, "python");
  const metadataRoot = join(testRoot, "metadata", "python");
  const sitePackages = join(pythonRoot, "lib", "python3.12", "site-packages");
  const packageLicenseRoot = join(sitePackages, "demo-1.0.dist-info", "licenses");
  const archivePath = join(testRoot, "python.tar.gz");
  const metadataArchivePath = join(testRoot, "python-metadata.tar.gz");
  const lockPath = join(testRoot, "requirements.lock");
  const outputRoot = join(testRoot, "runtime");
  const capturePath = join(testRoot, "python-invocation.txt");
  const scriptPath = resolve("scripts/install-python-runtime.sh");
  mkdirSync(join(pythonRoot, "bin"), { recursive: true });
  mkdirSync(packageLicenseRoot, { recursive: true });
  mkdirSync(join(metadataRoot, "licenses"), { recursive: true });
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  writeFileSync(
    join(pythonRoot, "bin", "python3"),
    [
      "#!/bin/sh",
      "printf '%s\\n' '---' >> \"$PI_WEB_TEST_CAPTURE\"",
      "printf '%s\\n' \"$@\" >> \"$PI_WEB_TEST_CAPTURE\"",
      "if [ \"${PI_WEB_TEST_FAIL_DOWNLOAD-}\" = '1' ] && [ \"${3-}\" = 'download' ]; then exit 23; fi",
      "if [ \"${1-}\" = '-m' ] && [ \"${2-}\" = 'pip' ] && [ \"${3-}\" = 'inspect' ]; then",
      "  printf '%s\\n' '{\"version\":\"1\",\"installed\":[]}'",
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(join(pythonRoot, "bin", "python3"), 0o755);
  writeFileSync(join(pythonRoot, "lib", "python3.12", "LICENSE.txt"), "Python license\n");
  writeFileSync(join(packageLicenseRoot, "LICENSE"), "Demo package license\n");
  writeFileSync(join(metadataRoot, "PYTHON.json"), '{"target_triple":"aarch64-unknown-linux-gnu"}\n');
  writeFileSync(join(metadataRoot, "licenses", "LICENSE.openssl-3.txt"), "OpenSSL license\n");
  writeFileSync(lockPath, "demo==1.0 --hash=sha256:fixture\n");

  const archiveResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveRoot, "python"], {
    encoding: "utf8",
  });
  assert.equal(archiveResult.status, 0, archiveResult.stderr);
  const metadataArchiveResult = spawnSync(
    "tar",
    ["-czf", metadataArchivePath, "-C", join(testRoot, "metadata"), "python"],
    { encoding: "utf8" },
  );
  assert.equal(metadataArchiveResult.status, 0, metadataArchiveResult.stderr);

  const installResult = spawnSync("bash", [
    scriptPath,
    archivePath,
    metadataArchivePath,
    lockPath,
    outputRoot,
  ], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, PI_WEB_TEST_CAPTURE: capturePath },
  });
  assert.equal(installResult.status, 0, installResult.stderr);

  assert.equal(existsSync(join(outputRoot, "bin", "python3")), true);
  const invocations = readFileSync(capturePath, "utf8").trim().split("\n---\n").map((entry) => entry.replace(/^---\n/, ""));
  assert.equal(invocations.length, 3);
  assert.match(invocations[0], /^-m\npip\ndownload\n/m);
  for (const platform of [
    "manylinux_2_31_aarch64",
    "manylinux_2_30_aarch64",
    "manylinux_2_29_aarch64",
    "manylinux_2_28_aarch64",
    "manylinux_2_27_aarch64",
    "manylinux_2_26_aarch64",
    "manylinux_2_25_aarch64",
    "manylinux_2_24_aarch64",
    "manylinux_2_23_aarch64",
    "manylinux_2_22_aarch64",
    "manylinux_2_21_aarch64",
    "manylinux_2_20_aarch64",
    "manylinux_2_19_aarch64",
    "manylinux_2_18_aarch64",
    "manylinux_2_17_aarch64",
    "manylinux2014_aarch64",
  ]) {
    assert.match(invocations[0], new RegExp(`--platform\\n${platform}`));
  }
  assert.match(invocations[0], /--python-version\n3\.12/);
  assert.match(invocations[0], /--implementation\ncp/);
  assert.match(invocations[0], /--abi\ncp312/);
  assert.match(invocations[0], /--require-hashes/);
  assert.match(invocations[1], /^-m\npip\ninstall\n/m);
  assert.match(invocations[1], /--no-index/);
  assert.match(invocations[1], /--find-links/);
  assert.match(invocations[1], /--require-hashes/);
  assert.equal(invocations[2], "-m\npip\ninspect\n--local");
  assert.equal(readFileSync(join(outputRoot, "licenses", "Python-LICENSE.txt"), "utf8"), "Python license\n");
  assert.equal(
    readFileSync(join(outputRoot, "licenses", "python-packages", "demo-1.0.dist-info", "licenses", "LICENSE"), "utf8"),
    "Demo package license\n",
  );
  assert.equal(
    readFileSync(join(outputRoot, "licenses", "runtime-components", "licenses", "LICENSE.openssl-3.txt"), "utf8"),
    "OpenSSL license\n",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(outputRoot, "licenses", "runtime-components", "PYTHON.json"), "utf8")),
    { target_triple: "aarch64-unknown-linux-gnu" },
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(outputRoot, "licenses", "python-packages.json"), "utf8")),
    { version: "1", installed: [] },
  );

  const failedOutputRoot = join(testRoot, "failed-runtime");
  const failedCapturePath = join(testRoot, "failed-python-invocation.txt");
  const failedInstallResult = spawnSync("bash", [
    scriptPath,
    archivePath,
    metadataArchivePath,
    lockPath,
    failedOutputRoot,
  ], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      PI_WEB_TEST_CAPTURE: failedCapturePath,
      PI_WEB_TEST_FAIL_DOWNLOAD: "1",
    },
  });
  assert.equal(failedInstallResult.status, 23);
  assert.equal(existsSync(failedOutputRoot), false);
});

test("Python 运行时安装脚本拒绝覆盖已有输出目录", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-python-runtime-existing-"));
  const archivePath = join(testRoot, "python.tar.gz");
  const metadataArchivePath = join(testRoot, "python-metadata.tar.gz");
  const lockPath = join(testRoot, "requirements.lock");
  const outputRoot = join(testRoot, "runtime");
  const markerPath = join(outputRoot, "keep.txt");
  const scriptPath = resolve("scripts/install-python-runtime.sh");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(archivePath, "fixture");
  writeFileSync(metadataArchivePath, "fixture");
  writeFileSync(lockPath, "fixture");
  writeFileSync(markerPath, "keep\n");
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  const result = spawnSync("bash", [
    scriptPath,
    archivePath,
    metadataArchivePath,
    lockPath,
    outputRoot,
  ], {
    cwd: resolve("."),
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /输出目录已存在/);
  assert.equal(readFileSync(markerPath, "utf8"), "keep\n");
});
