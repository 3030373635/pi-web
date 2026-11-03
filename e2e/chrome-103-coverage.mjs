import assert from "node:assert/strict";
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "test-results/chrome-103");
const suites = ["core", "settings", "content", "platform", "navigation"];
const expectedCases = JSON.parse(readFileSync(new URL("./chrome-103-cases.json", import.meta.url), "utf8"));
const reports = [];
const boundaries = new Set();
process.once("uncaughtException", (error) => {
  const details = String(error.stack || error).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.error(`::error title=Full-site coverage incomplete::${details}`);
  process.exitCode = 1;
});

/**
 * 递归读取矩阵作业生成的覆盖记录，不把截图或空报告视为通过。
 * @param {string} directory 下载的测试 artifact 目录。
 */
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.name === "coverage.json") {
      const coverage = JSON.parse(readFileSync(path, "utf8"));
      reports.push(...coverage.reports);
      for (const boundary of coverage.boundaries ?? []) boundaries.add(boundary);
    }
  }
}

collect(root);
for (const suite of suites) {
  for (const mode of ["start", "dev"]) {
    for (const browser of ["103", "current"]) {
      const matches = reports.filter((report) => report.suite === suite && report.mode === mode && report.browser === browser);
      assert.equal(matches.length, 1, `Missing or repeated report: ${suite}/${mode}/${browser}`);
      assert.equal(matches[0].passed, true, `Failed or incomplete report: ${suite}/${mode}/${browser}`);
      assert.ok(matches[0].checks.length > 0, `No assertion evidence: ${suite}/${mode}/${browser}`);
      const completed = new Set(matches[0].checks.map((check) => check.id));
      for (const id of expectedCases[suite]) assert.ok(completed.has(id), `Missing UI case: ${id}/${mode}/${browser}`);
      assert.equal(completed.size, expectedCases[suite].length, `Coverage inventory drift: ${suite}/${mode}/${browser}`);
    }
  }
}
const ids = [...new Set(reports.flatMap((report) => report.checks.map((check) => check.id)))].sort();
const summary = { sourceCommit: process.env.GITHUB_SHA, browserRuns: reports.length, distinctChecks: ids.length, ids, boundaries: [...boundaries], reports };
writeFileSync(join(root, "full-site-coverage.json"), JSON.stringify(summary, null, 2));
const lines = ["# Chrome 103 全站界面验收", "", "| Suite | Mode | Browser | Recorded checks |", "| --- | --- | --- | ---: |"];
for (const report of reports) lines.push(`| ${report.suite} | ${report.mode} | ${report.version} | ${report.checks.length} |`);
lines.push("", `通过 ${reports.length} 组浏览器执行，包含 ${ids.length} 个不同的验收 ID。`, "", "## 已验证与外部边界", "", ...[...boundaries].map((value) => `- ${value}`));
for (const report of reports) for (const limitation of report.limitations ?? []) lines.push(`- ${report.suite}/${report.mode}/${report.browser}: ${limitation}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
console.log(`::notice title=Full-site coverage verified::${reports.length} browser executions; ${ids.length} distinct UI checks; evidence and service/platform boundaries in full-site-coverage.json`);
