import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { showSidebarFiles } from "./sidebar.mjs";

/**
 * 等待浏览器交互产生的服务端证据，避免用固定延时猜测请求是否完成。
 * @param {() => unknown} read 读取当前证据的函数。
 * @param {string} message 超时后的错误说明。
 */
async function waitEvidence(read, message) {
  const deadline = Date.now() + 30_000;
  while (!read()) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}

/**
 * 断言真实控件在视口内且中心未被覆盖；Playwright 随后的 click 仍执行原生命中检查。
 * @param {import("playwright").Locator} control 要操作的真实组件控件。
 */
async function reachable(control) {
  await control.waitFor({ state: "visible" });
  await control.scrollIntoViewIfNeeded();
  assert.equal(await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth
      && y >= 0 && y < innerHeight && element.contains(document.elementFromPoint(x, y));
  }), true, "Platform control must be inside the viewport and unobscured");
}

/**
 * 保存真实平台面板截图，文件前缀区分 Chromium 103 与当前 Chromium。
 * @param {import("playwright").Page} page 当前应用页面。
 * @param {string} artifacts harness 提供的产物目录。
 * @param {string} surface 当前面板名称。
 */
async function capture(page, artifacts, surface) {
  const version = page.context().browser().version().split(".")[0];
  await page.screenshot({ path: join(artifacts, `${version}-platform-${surface}.png`), fullPage: true });
}

/**
 * 创建只提供测试事件的本地 HTTP 服务，保留浏览器原生 EventSource 与 xterm。
 * 有限 route.fulfill 响应会立刻关闭 SSE，故用重定向接入保持打开的流。
 * @param {string} project 终端夹具所属工作目录，仅用于事件内容。
 */
async function createEventService(project) {
  const streams = new Map();
  const sockets = new Set();
  const terminalOffsets = new Map();
  const terminalInputs = new Map();
  const opened = [];
  const service = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Access-Control-Allow-Origin": "*",
    });
    response.write(": mocked-service\n\n");
    if (!streams.has(path)) streams.set(path, new Set());
    streams.get(path).add(response);
    opened.push(path);
    request.on("close", () => streams.get(path)?.delete(response));
    if (path === "/agent") {
      response.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] })}\n\n`);
    } else {
      const data = `CHROME103_PLATFORM_TERMINAL_READY\r\n${project}\r\n`;
      terminalOffsets.set(path, data.length);
      response.write(`data: ${JSON.stringify({ type: "output", data, offset: data.length, reset: true })}\n\n`);
    }
  });
  service.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  const origin = `http://127.0.0.1:${service.address().port}`;
  return {
    origin,
    opened,
    /** 向现有原生 SSE 连接发送事件；path 是流路径，event 是源码约定的事件对象。 */
    send(path, event) {
      for (const response of streams.get(path) ?? []) response.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    /** 回显终端输入；id 是终端标识，data 是已经由真实 xterm 发来的字符。 */
    echo(id, data) {
      const path = `/terminal/${id}`;
      const input = (terminalInputs.get(path) ?? "") + data;
      terminalInputs.set(path, input);
      if (!input.includes("\r")) return;
      const output = `\r\nMOCK_ECHO:${input.replace(/[\r\n]/g, "")}\r\n`;
      terminalInputs.set(path, "");
      const offset = (terminalOffsets.get(path) ?? 0) + output.length;
      terminalOffsets.set(path, offset);
      for (const response of streams.get(path) ?? []) {
        response.write(`data: ${JSON.stringify({ type: "output", data: output, offset })}\n\n`);
      }
    },
    /** 销毁本次夹具的连接并关闭监听，不影响应用服务器；无参数。 */
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => service.close(resolve));
    },
  };
}

/**
 * 用真实登录页验证错误、限流、服务失败后的重试以及成功跳回原会话。
 * @param {import("playwright").Page} page 当前浏览器页面。
 * @param {object} options base 为应用地址，sessionId 为返回会话，authPassword 为隔离服务夹具密码，artifacts 为截图目录，record 为成功证据记录器。
 */
async function checkLogin(page, { base, sessionId, authPassword, artifacts, record }) {
  const attempts = [];
  const cookies = await page.context().cookies();
  const destination = `/?session=${encodeURIComponent(sessionId)}`;
  const authMatcher = (url) => url.origin === new URL(base).origin && url.pathname === "/api/web-auth";
  const authHandler = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    attempts.push(body);
    assert.equal(body.password, "chrome-103-fixture-password", "Only synthetic credentials may enter the mock");
    if (attempts.length === 1) return route.fulfill({ status: 401, json: { error: "Invalid password" } });
    if (attempts.length === 2) return route.fulfill({ status: 429, headers: { "retry-after": "2" }, json: { error: "Rate limited" } });
    if (attempts.length === 3) return route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
    // context.request 不经过 page.route；仅使用 harness 明确提供的假密码取得真实认证 cookie。
    const authenticated = await page.context().request.post(`${base}/api/web-auth`, { data: { password: authPassword } });
    assert.equal(authenticated.ok(), true, "Isolated fixture login must establish its real session cookie");
    return route.fulfill({ json: { success: true } });
  };
  await page.route(authMatcher, authHandler);
  try {
    await page.goto("about:blank");
    await page.context().clearCookies();
    await page.goto(`${base}/login?next=${encodeURIComponent(destination)}`);
    const password = page.locator("#web-login-password");
    const submit = page.getByRole("button", { name: "Log in", exact: true });
    await reachable(password);
    assert.equal(await submit.isDisabled(), true, "Empty password cannot be submitted");
    await password.fill("chrome-103-fixture-password");
    for (const message of ["Incorrect password", "Too many failed attempts. Try again in 2s.", "Could not log in. Try again."]) {
      await reachable(submit);
      await submit.click();
      await page.getByRole("alert").filter({ hasText: message }).waitFor();
      assert.equal(await password.isEnabled(), true, "Failure must permit another attempt");
      assert.equal(await password.inputValue(), "chrome-103-fixture-password");
    }
    await capture(page, artifacts, "login-retry");
    await submit.click();
    await page.waitForURL(`${base}${destination}`);
    await page.locator(".chat-input-textarea").waitFor();
    assert.equal(attempts.length, 4);
    record("platform.login.error-retry-success", { service: "mocked-service", assertions: "real LoginPage; empty disabled; POST 401/429 retry-after/503; editable retry; successful session redirect", requests: attempts.length });
  } finally {
    await page.unroute(authMatcher, authHandler);
    await page.context().clearCookies();
    await page.context().addCookies(cookies);
  }
}

/**
 * 验证终端创建、原生 SSE 渲染、键盘输入回显、独立主题、尺寸同步与关闭。
 * @param {import("playwright").Page} page 当前应用页面。
 * @param {object} options project 为工作目录，terminalRequests 为拦截日志，artifacts 为截图目录，record 为成功记录器。
 */
async function checkTerminal(page, { project, terminalRequests, artifacts, record }) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await showSidebarFiles(page);
  const open = page.getByRole("button", { name: "Open workspace terminal", exact: true });
  await reachable(open);
  await open.click();
  const panel = page.locator(".terminal-panel");
  await panel.locator(".terminal-status-dot.is-ready").waitFor();
  await page.waitForFunction(() => document.querySelector(".terminal-panel .xterm-rows")?.textContent.includes("CHROME103_PLATFORM_TERMINAL_READY"));
  const creation = terminalRequests.find((request) => request.method === "POST" && !request.body.type);
  assert.ok(creation, "Opening terminal must send POST /api/terminal");
  assert.equal(creation.body.cwd.replace(/\\/g, "/"), project.replace(/\\/g, "/"));
  assert.match(creation.body.id, /^[a-f0-9]{32}$/);
  assert.ok(creation.body.cols >= 2 && creation.body.rows >= 2);
  await panel.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("chrome103-input");
  await page.keyboard.press("Enter");
  await waitEvidence(() => terminalRequests.filter((request) => request.body?.type === "input").map((request) => request.body.data).join("").includes("chrome103-input\r"), "xterm must send the typed input to the terminal API");
  // 由服务按回车合并真实输入请求，既验证键盘发送，也验证 SSE 内容进入 xterm。
  await page.waitForFunction(() => document.querySelector(".terminal-panel .xterm-rows")?.textContent.includes("MOCK_ECHO:chrome103-input"));
  const beforeTheme = await panel.getAttribute("data-terminal-theme");
  const theme = panel.getByRole("button", { name: /Switch terminal to (light|dark) theme/ });
  await reachable(theme);
  await theme.click();
  await page.waitForFunction((before) => document.querySelector(".terminal-panel")?.dataset.terminalTheme !== before, beforeTheme);
  assert.equal(terminalRequests.filter((request) => request.method === "POST" && !request.body.type).length, 1, "Theme switch preserves the shell and stream");
  await waitEvidence(() => terminalRequests.some((request) => request.body?.type === "resize"), "SSE open must initialize terminal dimensions");
  const initialResizeCount = terminalRequests.filter((request) => request.body?.type === "resize").length;
  const beforeDimensions = terminalRequests.filter((request) => request.body?.type === "resize").at(-1)?.body;
  await page.setViewportSize({ width: 1080, height: 600 });
  await waitEvidence(() => terminalRequests.filter((request) => request.body?.type === "resize").length > initialResizeCount, "Viewport change must resize the PTY through POST");
  const resize = terminalRequests.filter((request) => request.body?.type === "resize").at(-1).body;
  assert.ok(Number.isInteger(resize.cols) && Number.isInteger(resize.rows) && resize.cols >= 2 && resize.rows >= 2);
  assert.ok(resize.cols !== beforeDimensions.cols || resize.rows !== beforeDimensions.rows, "Resize must carry changed dimensions");
  await capture(page, artifacts, "terminal");
  const close = page.getByRole("button", { name: /^Terminate terminal / }).last();
  await reachable(close);
  await close.click();
  await panel.waitFor({ state: "detached" });
  assert.ok(terminalRequests.some((request) => request.method === "DELETE" && request.path.endsWith(creation.body.id)), "Closing the tab must terminate its terminal id");
  record("platform.terminal.lifecycle", { service: "mocked-service", assertions: "real xterm/native SSE output; keyboard input API + echo; theme keeps terminal; changed integer resize; DELETE on close", requests: terminalRequests.length });
  await page.setViewportSize({ width: 1280, height: 800 });
}

/**
 * 从真实 Agent 工具卡打开只读子代理视图，验证正文、滚动、向前分页与关闭。
 * @param {import("playwright").Page} page 当前应用页面。
 * @param {object} options childId 为模拟子代理，contextRequests 为分页日志，childAgentRequests 为禁止的运行请求日志，artifacts 为截图目录，record 为成功记录器。
 */
async function checkSubagent(page, { childId, contextRequests, childAgentRequests, artifacts, record }) {
  const open = page.getByRole("button", { name: "View sub-agent work in side panel", exact: true });
  await open.scrollIntoViewIfNeeded();
  await reachable(open);
  await open.click();
  const panel = page.locator("#file-panel");
  await panel.getByText("PLATFORM_SUBAGENT_LATEST", { exact: false }).waitFor();
  await panel.getByRole("button", { name: "Refresh", exact: true }).waitFor();
  const scroll = panel.locator("div[lang]");
  await page.waitForFunction(() => {
    const element = document.querySelector('#file-panel div[lang]');
    return element && element.scrollHeight > element.clientHeight + 100;
  });
  const before = await scroll.evaluate((element) => element.scrollTop);
  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForFunction((previous) => document.querySelector('#file-panel div[lang]')?.scrollTop < previous - 30, before);
  await scroll.evaluate((element) => { element.scrollTop = 0; });
  await panel.getByRole("button", { name: "Load more", exact: true }).click();
  await panel.getByText("PLATFORM_SUBAGENT_EARLIER", { exact: false }).waitFor();
  assert.ok(contextRequests.some((request) => request.id === childId && request.before === "platform-child-0"), "Load more must request before the oldest entry");
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await waitEvidence(() => contextRequests.filter((request) => !request.before).length >= 2, "Refresh must fetch a new tail page");
  await capture(page, artifacts, "subagent");
  assert.equal(childAgentRequests.length, 0, "Read-only viewer never touches an agent API");
  const close = panel.getByRole("button", { name: "Close Platform child", exact: true });
  await reachable(close);
  await close.click();
  await panel.getByRole("tab", { name: "Sub-agent Platform child", exact: true }).waitFor({ state: "detached" });
  record("platform.subagent.transcript", { service: "mocked-service", assertions: "real Agent-card entry; child info + transcript; wheel; before pagination; refresh; tab close; zero child agent API", requests: contextRequests.length });
}

/**
 * 验证系统提示词与工具定义的真实读取命令、正文、选择与长内容滚动。
 * @param {import("playwright").Page} page 当前应用页面。
 * @param {object} options agentCommands 为请求日志，artifacts 为截图目录，record 为成功记录器。
 */
async function checkSystemPanels(page, { agentCommands, artifacts, record }) {
  const previousStates = agentCommands.filter((command) => command.type === "get_state").length;
  await page.getByRole("button", { name: "System prompt", exact: true }).click();
  const prompt = page.locator(".system-prompt-panel");
  await prompt.getByText("PLATFORM_SYSTEM_PROMPT", { exact: false }).waitFor();
  await waitEvidence(() => agentCommands.filter((command) => command.type === "get_state").length > previousStates, "Opening System prompt must send a fresh get_state command");
  const scroll = prompt.locator(".system-prompt-scroll");
  assert.ok(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight));
  await scroll.hover();
  await page.mouse.wheel(0, 500);
  await page.waitForFunction(() => document.querySelector(".system-prompt-scroll")?.scrollTop > 30);
  await capture(page, artifacts, "system-prompt");
  await page.keyboard.press("Escape");
  await prompt.waitFor({ state: "hidden" });
  record("platform.system-prompt", { service: "mocked-service", assertions: "System prompt toolbar -> get_state; rendered prompt; bounded real wheel scroller; Escape close" });
  const previousTools = agentCommands.filter((command) => command.type === "get_tools").length;
  await page.getByRole("button", { name: "Tool definitions", exact: true }).click();
  const tools = page.locator(".tool-definitions-panel");
  await tools.getByRole("button", { name: "platform_read", exact: true }).waitFor();
  await tools.getByText("Read a platform fixture", { exact: true }).waitFor();
  await tools.getByRole("button", { name: "platform_list", exact: true }).click();
  assert.equal(await tools.getByRole("button", { name: "platform_list", exact: true }).getAttribute("aria-pressed"), "true");
  await tools.getByText("List platform fixture entries", { exact: true }).waitFor();
  await tools.getByText("directory", { exact: true }).waitFor();
  await tools.getByText("Fixture directory parameter", { exact: true }).waitFor();
  await waitEvidence(() => agentCommands.filter((command) => command.type === "get_tools").length > previousTools, "Opening Tool definitions must send a fresh get_tools command");
  await capture(page, artifacts, "tool-definitions");
  await page.keyboard.press("Escape");
  await tools.waitFor({ state: "hidden" });
  record("platform.tool-definitions", { service: "mocked-service", assertions: "toolbar -> get_tools; active definitions; selectable tools; schema parameter description; Escape close" });
}

/**
 * 验证扩展状态按钮及 SSE 到真实选择、确认、输入、编辑器和自定义面板的闭环。
 * @param {import("playwright").Page} page 当前应用页面。
 * @param {object} options events 为本地 SSE 服务，agentCommands 为协议日志，artifacts 为截图目录，record 为成功记录器。
 */
async function checkExtensions(page, { events, agentCommands, artifacts, record }) {
  const methods = ["select", "confirm", "input", "editor", "custom"];
  for (const method of methods) {
    events.send("/agent", { type: "extension_ui_request", id: `status-${method}`, method: "setStatus", statusKey: `command:/platform-dialog ${method}`, statusText: `Platform ${method}` });
    const trigger = page.getByRole("button", { name: `Platform ${method} (/platform-dialog ${method})`, exact: true });
    await reachable(trigger);
    await trigger.click();
    await waitEvidence(() => agentCommands.some((command) => command.type === "prompt" && command.message === `/platform-dialog ${method}`), "Status command must send its registered extension command");
    const dialog = method === "custom" ? page.getByRole("dialog").filter({ hasText: "PLATFORM_CUSTOM_PANEL" }) : page.getByRole("dialog", { name: `Platform ${method}`, exact: true });
    await dialog.waitFor();
    await capture(page, artifacts, `extension-${method}`);
    if (method === "select") {
      await dialog.getByRole("button", { name: "Choice 1", exact: true }).focus();
      await page.keyboard.press("End");
      assert.equal(await page.locator(":focus").getAttribute("aria-label"), "Choice 24");
      await reachable(dialog.getByRole("button", { name: "Choice 24", exact: true }));
      await page.keyboard.press("Enter");
    } else if (method === "confirm") {
      await dialog.getByText("PLATFORM_CONFIRM_BODY", { exact: false }).waitFor();
      await reachable(dialog.getByRole("button", { name: "Confirm", exact: true }));
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    } else if (method === "input" || method === "editor") {
      await dialog.getByRole("textbox").fill(`platform-${method}-value`);
      await dialog.getByRole("button", { name: "Collapse", exact: true }).click();
      await page.getByRole("button", { name: new RegExp(`Awaiting response.*Platform ${method}`) }).click();
      assert.equal(await dialog.getByRole("textbox").inputValue(), `platform-${method}-value`);
      await reachable(dialog.getByRole("button", { name: "Submit", exact: true }));
      await dialog.getByRole("button", { name: "Submit", exact: true }).click();
    } else {
      await dialog.click({ position: { x: 80, y: 20 } });
      await page.keyboard.press("Control+c");
    }
    await dialog.waitFor({ state: "hidden" });
    const expectedType = method === "custom" ? "extension_ui_input" : "extension_ui_response";
    await waitEvidence(() => agentCommands.some((command) => command.type === expectedType && command.id === `platform-${method}`), "Extension response must be sent through the real agent client");
    const response = agentCommands.find((command) => command.type === expectedType && command.id === `platform-${method}`);
    if (method === "select") assert.equal(response.value, "Choice 24");
    else if (method === "confirm") assert.equal(response.confirmed, true);
    else if (method === "custom") assert.equal(response.data, "\u0003");
    else assert.equal(response.value, `platform-${method}-value`);
  }
  record("platform.extensions.dialogs", { service: "mocked-service", assertions: "status slash-command entry; select End/Enter; confirm body/response; input/editor collapse preserves draft + submit; exact protocol responses" });
  record("platform.extensions.custom-panel", { service: "mocked-service", assertions: "real custom panel renders SSE lines; Ctrl+C -> extension_ui_input U+0003 -> server close" });
  events.send("/agent", { type: "extension_ui_request", id: "platform-widget", method: "setWidget", widgetKey: "Platform widget", widgetLines: ["PLATFORM_WIDGET_CONTENT", "second", "third", "fourth"], widgetPlacement: "belowEditor" });
  const widget = page.getByRole("button", { name: /Platform widget, 4 lines/ });
  await reachable(widget);
  await widget.click();
  await page.locator(".extension-widget-panel").getByText("PLATFORM_WIDGET_CONTENT", { exact: false }).waitFor();
  assert.equal(await widget.getAttribute("aria-expanded"), "true");
  await widget.click();
  await page.locator(".extension-widget-panel").waitFor({ state: "hidden" });
  record("platform.extensions.status-widgets", { service: "mocked-service", assertions: "setStatus renders executable command buttons; setWidget renders accessible trigger; expansion content and collapse" });
}

/**
 * 全站平台交互验收入口；所有受控服务都使用真实组件及源码定义的请求/事件。
 * @param {import("playwright").Page} page harness 提供的 Chromium 页面。
 * @param {object} options base 为服务地址，project 为夹具目录，artifacts 为产物目录，sessionId 为原会话，authPassword 为隔离服务假密码，record 同步记录成功证据。
 */
export async function checkFullSitePlatform(page, { base, project, artifacts, sessionId, authPassword = "chrome-103-ui-fixture", record }) {
  const originalViewport = page.viewportSize();
  const storage = await page.evaluate(() => ({ terminalTheme: localStorage.getItem("pi-web:terminal-theme"), terminalTabs: sessionStorage.getItem("pi-web:terminal-tabs") }));
  const snapshotResponse = await page.request.get(`${base}/api/sessions/${encodeURIComponent(sessionId)}`);
  assert.equal(snapshotResponse.ok(), true);
  const originalSnapshot = await snapshotResponse.json();
  const childId = "chrome-103-platform-child";
  const timestamp = "2026-11-03T00:00:00.000Z";
  const messages = [
    { role: "user", content: "Show platform child work", timestamp: 1 },
    { role: "assistant", model: "fixture", provider: "fixture", timestamp: 2, content: [{ type: "toolCall", toolCallId: "platform-agent-call", toolName: "Agent", input: { profile: "explore", description: "Platform child" } }] },
    { role: "toolResult", toolCallId: "platform-agent-call", toolName: "Agent", timestamp: 3, content: [{ type: "text", text: "Platform child completed" }], details: { kind: "pi-web-subagent", sessionId: childId, profile: "explore", description: "Platform child", status: "completed", runInBackground: false, createdAt: timestamp, completedAt: timestamp } },
  ];
  const snapshot = { ...originalSnapshot, snapshotRevision: null, context: { ...originalSnapshot.context, messages, entryIds: ["platform-user", "platform-assistant", "platform-result"], oldestEntryId: "platform-user", hasMore: false, turnsBefore: 0 } };
  const childMessages = Array.from({ length: 20 }, (_, index) => ({ role: "assistant", model: "fixture", provider: "fixture", timestamp: 100 + index, content: [{ type: "text", text: `${index === 19 ? "PLATFORM_SUBAGENT_LATEST" : `Platform child entry ${index}`}\n\n${"Child transcript content.\n\n".repeat(4)}` }] }));
  const tools = [
    { name: "platform_read", active: true, description: "Read a platform fixture", parameters: { type: "object", properties: { path: { type: "string", description: "Fixture path parameter" } }, required: ["path"] } },
    { name: "platform_list", active: true, description: "List platform fixture entries", parameters: { type: "object", properties: { directory: { type: "string", description: "Fixture directory parameter" } }, required: ["directory"] } },
  ];
  const state = { isStreaming: false, isPromptRunning: false, isCompacting: false, systemPrompt: `PLATFORM_SYSTEM_PROMPT\n${"Source-defined system prompt fixture.\n".repeat(180)}`, extensionStatuses: [], extensionWidgets: [] };
  const terminalRequests = [];
  const agentCommands = [];
  const contextRequests = [];
  const childAgentRequests = [];
  const events = await createEventService(project);
  const appOrigin = new URL(base).origin;
  const matcher = (url) => url.origin === appOrigin && (url.pathname.startsWith("/api/terminal") || url.pathname.startsWith(`/api/agent/${sessionId}`) || url.pathname.startsWith(`/api/agent/${childId}`) || url.pathname.startsWith(`/api/sessions/${sessionId}`) || url.pathname.startsWith(`/api/sessions/${childId}`));
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    if (path.startsWith(`/api/agent/${childId}`)) {
      childAgentRequests.push(path);
      return route.fulfill({ status: 400, json: { error: "Viewer must not start a child AgentSession" } });
    }
    if (path === `/api/sessions/${sessionId}`) return route.fulfill({ json: snapshot });
    if (path === `/api/sessions/${sessionId}/state` || path === `/api/agent/${sessionId}` && method === "GET") return route.fulfill({ json: { running: true, state } });
    if (path === `/api/sessions/${childId}`) return route.fulfill({ json: { info: { ...originalSnapshot.info, id: childId, name: "Platform child", cwd: project, relation: { kind: "subagent", parentSessionId: sessionId, profile: "explore", description: "Platform child", status: "completed" } } } });
    if (path === `/api/sessions/${childId}/context`) {
      const before = url.searchParams.get("before");
      contextRequests.push({ id: childId, before, tail: url.searchParams.get("tail") });
      assert.equal(url.searchParams.get("tail"), "100");
      return route.fulfill({ json: { context: before
        ? { messages: [{ role: "user", content: "PLATFORM_SUBAGENT_EARLIER", timestamp: 99 }], entryIds: ["platform-child-earlier"], oldestEntryId: "platform-child-earlier", hasMore: false }
        : { messages: childMessages, entryIds: childMessages.map((_, index) => `platform-child-${index}`), oldestEntryId: "platform-child-0", hasMore: true } } });
    }
    if (path === `/api/agent/${sessionId}/events`) return route.fulfill({ status: 307, headers: { location: `${events.origin}/agent`, "Access-Control-Allow-Origin": "*" }, body: "" });
    if (path === `/api/agent/${sessionId}/lease`) return route.fulfill({ json: { running: true, awaitingInput: false, subagentsActive: false } });
    if (path === `/api/agent/${sessionId}` && method === "POST") {
      const body = request.postDataJSON();
      agentCommands.push(body);
      if (body.type === "get_state") return route.fulfill({ json: { success: true, data: state } });
      if (body.type === "get_tools") return route.fulfill({ json: { success: true, data: tools } });
      if (body.type === "get_commands") return route.fulfill({ json: { success: true, data: { commands: [{ name: "platform-dialog", description: "Mocked platform extension", source: "extension" }] } } });
      if (body.type === "prompt") {
        assert.match(body.message, /^\/platform-dialog (select|confirm|input|editor|custom)$/);
        const method = body.message.split(" ")[1];
        await route.fulfill({ json: { success: true, data: null } });
        const event = { type: "extension_ui_request", id: `platform-${method}`, method };
        if (method === "custom") event.lines = ["PLATFORM_CUSTOM_PANEL", "Press Ctrl+C to finish"];
        else event.title = `Platform ${method}`;
        if (method === "select") event.options = Array.from({ length: 24 }, (_, index) => `Choice ${index + 1}`);
        if (method === "confirm") event.message = "PLATFORM_CONFIRM_BODY\n\nConfirm fixture interaction.";
        if (method === "input") event.placeholder = "Platform input";
        if (method === "editor") event.prefill = "Platform editor draft";
        events.send("/agent", event);
        events.send("/agent", { type: "prompt_done" });
        return;
      }
      if (body.type === "extension_ui_response" || body.type === "extension_ui_input") {
        await route.fulfill({ json: { success: true, data: null } });
        if (body.type === "extension_ui_input") events.send("/agent", { type: "extension_ui_request", id: body.id, method: "custom", lines: [], closed: true });
        return;
      }
      return route.fulfill({ status: 400, json: { error: `Unexpected mocked command ${body.type}` } });
    }
    if (path.startsWith("/api/terminal")) {
      const body = method === "POST" ? request.postDataJSON() : undefined;
      terminalRequests.push({ path, method, body });
      if (path.endsWith("/events")) {
        const id = path.split("/")[3];
        return route.fulfill({ status: 307, headers: { location: `${events.origin}/terminal/${id}`, "Access-Control-Allow-Origin": "*" }, body: "" });
      }
      if (path === "/api/terminal") return route.fulfill({ json: { id: body.id } });
      if (body?.type === "input") events.echo(path.split("/")[3], body.data);
      return route.fulfill({ json: method === "GET" ? { id: path.split("/")[3], cwd: project } : { success: true } });
    }
    return route.fallback();
  };
  await page.route(matcher, handler);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await checkLogin(page, { base, sessionId, authPassword, artifacts, record });
    const agentOpenCount = events.opened.filter((path) => path === "/agent").length;
    await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
    await page.locator(".chat-input-textarea").waitFor();
    await waitEvidence(() => events.opened.filter((path) => path === "/agent").length > agentOpenCount, "Application must open its native mocked event stream after navigation");
    await checkSystemPanels(page, { agentCommands, artifacts, record });
    await checkTerminal(page, { project, terminalRequests, artifacts, record });
    await checkSubagent(page, { childId, contextRequests, childAgentRequests, artifacts, record });
    await checkExtensions(page, { events, agentCommands, artifacts, record });
    // 登出使用隔离服务真实 cookie，补上与受控登录 UI 不同的服务集成路径。
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.locator(".settings-section-tabs").getByRole("button", { name: "General", exact: true }).click();
    await settings.getByRole("button", { name: "Log out", exact: true }).click();
    await page.waitForURL(`${base}/login`);
    await reachable(page.locator("#web-login-password"));
    const denied = await page.context().request.get(`${base}/api/sessions`);
    assert.equal(denied.status(), 401, "Logout must revoke the fixture browser session");
    const restored = await page.context().request.post(`${base}/api/web-auth`, { data: { password: authPassword } });
    assert.ok(restored.ok());
    record("platform.logout.local-cookie", { service: "real-local-auth", assertions: "Settings General Log out clears actual fixture cookie; login page is reachable; protected API returns 401; restored with synthetic password" });
    await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
    await page.locator(".chat-input-textarea").waitFor();
    const version = page.context().browser().version().split(".")[0];
    await page.screenshot({ path: join(artifacts, `${version}-platform.png`), fullPage: true });
    return { uncovered: [] };
  } catch (error) {
    await capture(page, artifacts, "failure").catch(() => {});
    throw error;
  } finally {
    // 先卸载真实组件关闭 SSE，再移除本函数的路由；避免清理过程连入真实 PTY/扩展。
    await page.evaluate((saved) => {
      if (saved.terminalTheme === null) localStorage.removeItem("pi-web:terminal-theme");
      else localStorage.setItem("pi-web:terminal-theme", saved.terminalTheme);
      if (saved.terminalTabs === null) sessionStorage.removeItem("pi-web:terminal-tabs");
      else sessionStorage.setItem("pi-web:terminal-tabs", saved.terminalTabs);
    }, storage).catch(() => {});
    await page.goto("about:blank").catch(() => {});
    try {
      await page.unroute(matcher, handler);
    } finally {
      await events.close();
    }
    if (originalViewport) await page.setViewportSize(originalViewport);
    await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
    await page.locator(".chat-input-textarea").waitFor();
  }
}
