import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Python ELF 审计拒绝高于目标版本的 GLIBC 符号", (t) => {
  const testRoot = mkdtempSync(join(tmpdir(), "pi-web-python-glibc-audit-"));
  const runtimeRoot = join(testRoot, "runtime");
  const toolsRoot = join(testRoot, "tools");
  const scriptPath = resolve("scripts/audit-python-glibc.sh");
  mkdirSync(runtimeRoot, { recursive: true });
  mkdirSync(toolsRoot, { recursive: true });
  t.after(() => rmSync(testRoot, { recursive: true, force: true }));

  writeFileSync(join(runtimeRoot, "compatible.so"), "fixture\n");
  writeFileSync(
    join(toolsRoot, "file"),
    "#!/bin/sh\nprintf '%s\\n' 'ELF 64-bit LSB shared object, ARM aarch64'\n",
  );
  writeFileSync(
    join(toolsRoot, "readelf"),
    [
      "#!/bin/sh",
      "for last_argument do :; done",
      "case \"$last_argument\" in",
      "  *too-new.so) printf '%s\\n' 'Name: GLIBC_2.34' ;;",
      "  *) printf '%s\\n' 'Name: GLIBC_2.17' 'Name: GLIBC_2.28' ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(join(toolsRoot, "file"), 0o755);
  chmodSync(join(toolsRoot, "readelf"), 0o755);
  const env = { ...process.env, PATH: `${toolsRoot}${delimiter}${process.env.PATH ?? ""}` };

  const compatibleResult = spawnSync("bash", [scriptPath, runtimeRoot, "2.31"], {
    cwd: resolve("."),
    encoding: "utf8",
    env,
  });
  assert.equal(compatibleResult.status, 0, compatibleResult.stderr);
  assert.match(compatibleResult.stdout, /最高 GLIBC 符号版本: 2\.28/);

  writeFileSync(join(runtimeRoot, "too-new.so"), "fixture\n");
  const incompatibleResult = spawnSync("bash", [scriptPath, runtimeRoot, "2.31"], {
    cwd: resolve("."),
    encoding: "utf8",
    env,
  });
  assert.equal(incompatibleResult.status, 1);
  assert.match(incompatibleResult.stderr, /too-new\.so.*GLIBC_2\.34.*高于允许的 2\.31/);
});
