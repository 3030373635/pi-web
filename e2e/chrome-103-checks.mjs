import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checks = {
  lint: [join(root, "node_modules/eslint/bin/eslint.js"), "."],
  types: [join(root, "node_modules/typescript/bin/tsc"), "--noEmit"],
  unit: ["--test", "lib/chrome-103-compat.test.mjs", "lib/offline-windows-package.test.mjs"],
};
const name = process.argv[2];
assert.ok(Object.hasOwn(checks, name), "Expected lint, types or unit");
const result = spawnSync(process.execPath, checks[name], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error || result.status !== 0) {
  // CI 公开注释保留真正失败原因，不能仅报告一个无从定位的退出码。
  const details = `${result.error || ""}\n${result.stdout || ""}\n${result.stderr || ""}`.slice(-12000)
    .replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.error(`::error title=Windows ${name} failed::${details}`);
  process.exitCode = result.status || 1;
}
