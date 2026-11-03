import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSessionNavigation } from "./session-navigation.mjs";
import { createProjectNavigationFixtures, checkProjectNavigation } from "./project-navigation.mjs";

/**
 * 在 SDK 首次扫描前创建会话及真实 Git 工作树，所有写入留在测试隔离目录。
 * @param {{agentDir:string,sessionDirectory:string,project:string,timestamp:string}} options 测试目录与时间。
 * @returns {{a:object,b:object,project:object}} 导航所需的真实本地夹具。
 */
export function prepareFullSiteNavigation({ agentDir, sessionDirectory, project, timestamp }) {
  const fixtures = [
    { id: "compat-navigation-a", entry: "navigation-a-answer", text: "Chrome103 navigation answer A" },
    { id: "compat-navigation-b", entry: "navigation-b-answer", text: "Chrome103 navigation answer B" },
  ];
  for (const fixture of fixtures) {
    const entries = [
      { type: "session", version: 3, id: fixture.id, timestamp, cwd: project },
      { type: "message", id: `${fixture.id}-question`, parentId: null, timestamp, message: { role: "user", content: `Question for ${fixture.id}` } },
      { type: "message", id: fixture.entry, parentId: `${fixture.id}-question`, timestamp, message: { role: "assistant", content: fixture.text } },
    ];
    writeFileSync(join(sessionDirectory, `2026-11-03T00-00-00-000Z_${fixture.id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  return { a: fixtures[0], b: fixtures[1], project: createProjectNavigationFixtures({ agentDir, sessionDir: sessionDirectory, timestamp }) };
}

/**
 * 复用已有深度导航回归，覆盖真实会话与项目/工作树的跨标签页交互。
 * @param {import('playwright').Page} page 外层测试页面，执行期间释放其 SSE 连接。
 * @param {{browser:object,base:string,artifacts:string,sessionId:string,record:Function,fixtures:object}} options 浏览器与真实本地服务夹具。
 */
export async function checkFullSiteNavigation(page, { browser, base, artifacts, sessionId, record, fixtures }) {
  /**
   * 读取隔离的真实 API，并验证成功状态。
   * @param {string} path 同源 API 路径。
   * @returns {Promise<object>} JSON 响应。
   */
  async function api(path) {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, path);
    return response.json();
  }
  /**
   * 提交仅影响测试夹具的项目 UI 状态。
   * @param {string} path 同源 API 路径。
   * @param {object} body API 请求体。
   * @returns {Promise<object>} JSON 响应。
   */
  async function post(path, body) {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  }
  await page.goto("about:blank");
  try {
    await checkSessionNavigation({
      browser, base, artifacts, a: fixtures.a, b: fixtures.b, api,
      deleteSession: async (id) => {
        const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
        assert.ok(response.ok, `delete isolated fork: ${response.status}`);
      },
    });
    record("navigation.sessions", { service: "real-local-api", assertions: "plain click/Enter, modified/middle click, row-menu new tabs, reload, pin/archive/restore, missing session, keyboard fork focus and deletion; no model prompt" });
    // 原 helper 会删除空目录来测试失效路径；每个浏览器都重新创建同一隔离夹具。
    mkdirSync(fixtures.project.empty, { recursive: true });
    await checkProjectNavigation({ browser, base, artifacts, fixture: fixtures.project, otherSessionId: fixtures.a.id, api, post });
    record("navigation.projects-worktrees", { service: "real-local-api", assertions: "actual linked Git worktree, project menus, current/other/empty project new tabs, preserved drafts and HTML iframe, in-place new composer, unavailable directory; desktop and narrow layouts" });
  } finally {
    await page.goto(`${base}/?session=${sessionId}`, { waitUntil: "domcontentloaded" });
  }
}
