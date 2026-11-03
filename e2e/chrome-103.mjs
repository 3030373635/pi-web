import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { showSidebarFiles, checkFilesPlacement } from "./sidebar.mjs";

const require = createRequire(import.meta.url);
const { rewriteCssValue } = require("../compat/chrome-103/values.cjs");
const { CHROME_103_INIT_SCRIPT } = require("../compat/chrome-103/init.cjs");
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.env.E2E_SERVER_MODE || "start";
assert.ok(mode === "start" || mode === "dev", "E2E_SERVER_MODE must be start or dev");
const artifacts = join(root, "test-results/chrome-103", mode);
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-chrome-103-"));
const project = join(agentDir, "project");
const sessionDirectory = join(agentDir, "sessions", "compat");
mkdirSync(artifacts, { recursive: true });
mkdirSync(project);
mkdirSync(sessionDirectory, { recursive: true });
writeFileSync(join(project, "notes.txt"), "Chrome 103 file viewer\n" + "Scrollable file contents\n".repeat(300));
const timestamp = "2026-11-03T00:00:00.000Z";
const sessionId = "chrome-103-regression";
const entries = [{ type: "session", version: 3, id: sessionId, timestamp, cwd: project }];
for (let index = 0; index < 60; index++) {
  entries.push({ type: "message", id: `message-${index}`, parentId: index ? `message-${index - 1}` : null, timestamp,
    message: { role: index % 2 ? "assistant" : "user", content: index % 2
      ? [{ type: "text", text: `Reply ${index}\n\n` + "Long transcript paragraph.\n\n".repeat(10) }]
      : `Question ${index}` } });
}
writeFileSync(join(sessionDirectory, `2026-11-03T00-00-00-000Z_${sessionId}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

/**
 * 验证元素在视口内且实际可点击，防止仅检查 DOM 存在。
 * @param {import('playwright').Locator} locator 需要验收的控件。
 */
async function assertReachable(locator) {
  await locator.waitFor({ state: "visible" });
  assert.equal(await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const x = Math.max(0, box.left) + Math.min(box.width, innerWidth - box.left) / 2;
    const y = box.top + box.height / 2;
    return box.top >= 0 && box.bottom <= innerHeight + 1 && element.contains(document.elementFromPoint(x, y));
  }), true, "Control must be reachable inside the viewport");
}

/**
 * 用真实滚轮验证滚动，再确认输入框未被长内容推出屏幕。
 * @param {import('playwright').Page} page 当前应用页面。
 */
async function checkTranscript(page) {
  const scroll = page.locator(".chat-content .overflow-y-auto").first();
  await page.waitForFunction(() => {
    const element = document.querySelector(".chat-content .overflow-y-auto");
    return element && element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 100;
  });
  await scroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const before = await scroll.evaluate((element) => element.scrollTop);
  await scroll.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForFunction((position) => document.querySelector(".chat-content .overflow-y-auto").scrollTop < position - 50, before);
  await assertReachable(page.locator(".chat-input-textarea"));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
}

/**
 * 在未加载应用前重现无效高度导致的裁切，再验证相同结构的回退。
 * @param {import('playwright').Page} page Chromium 103 的页面。
 */
async function checkOriginalRegression(page) {
  const source = readFileSync(join(root, "components/AppShell.tsx"), "utf8");
  assert.ok(source.includes('height: "var(--app-viewport-height, 100dvh)"'), "Upstream changed the shell: update this regression fixture deliberately");
  const height = "var(--app-viewport-height, 100dvh)";
  await page.setContent(`<style>html,body{height:100vh;margin:0;overflow:hidden}#shell{display:flex;height:${height}}main{display:flex;flex-direction:column}#scroll{flex:1;min-height:0;overflow:auto}</style><div id="shell"><main><div id="scroll"><div style="height:4000px">Long conversation</div></div><textarea></textarea></main></div>`);
  assert.equal(await page.evaluate(() => CSS.supports("height", "100dvh")), false);
  assert.equal(await page.locator("#scroll").evaluate((element) => element.clientHeight >= element.scrollHeight), true, "RED: original container grows with the transcript");
  await page.screenshot({ path: join(artifacts, "103-before.png") });
  await page.addScriptTag({ content: CHROME_103_INIT_SCRIPT });
  await page.locator("#shell").evaluate((element, value) => { element.style.height = value; }, rewriteCssValue(height));
  assert.equal(await page.locator("#scroll").evaluate((element) => element.scrollHeight > element.clientHeight), true, "GREEN: same structure now has a bounded scroller");
}

/**
 * 验证所有设置页、主题切换、短窗口滚动和鼠标/键盘选中状态。
 * @param {import('playwright').Page} page 当前应用页面。
 * @param {string} name 浏览器产物前缀。
 */
async function checkSettings(page, name) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const sections = dialog.locator(".settings-section-tabs button");
  assert.equal(await sections.count(), 6);
  for (let index = 0; index < 6; index++) {
    await sections.nth(index).click();
    await assertReachable(dialog.getByRole("button", { name: "Close", exact: true }));
    const content = dialog.locator(".settings-section-host:not([hidden])");
    await content.waitFor();
    assert.ok((await content.innerText()).trim().length > 0, "Every settings section renders its controls");
    await page.screenshot({ path: join(artifacts, `${name}-settings-${index}.png`) });
  }
  await sections.first().click();
  const light = page.getByRole("radio", { name: "Light", exact: true });
  const dark = page.getByRole("radio", { name: "Dark", exact: true });
  for (const radio of [dark, light]) {
    await radio.locator("..").click();
    await page.mouse.move(1, 1);
    assert.equal(await radio.isChecked(), true);
    await page.waitForFunction(() => {
      const input = document.querySelector(".settings-theme-option input:checked");
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const channels = accent.slice(1).match(/../g).map((part) => parseInt(part, 16));
      return input && getComputedStyle(input.parentElement).boxShadow.includes(`rgb(${channels.join(", ")})`);
    });
  }
  await dark.focus();
  await page.keyboard.press("Space");
  assert.equal(await dark.isChecked(), true, "Keyboard Space selects the focused theme");
  await page.waitForFunction(() => {
    const input = document.querySelector(".settings-theme-option input:checked");
    const style = input && getComputedStyle(input.parentElement);
    return input?.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2;
  });
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.locator(".settings-general").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await assertReachable(page.locator(".settings-language-options button:last-child"));
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await checkTranscript(page);
}

let server;
let browser;
let context;
let page;
const serverLog = createWriteStream(join(artifacts, "server.log"));
try {
  assert.ok(process.env.CHROME_103_PATH, "CHROME_103_PATH must point to the real Chromium 103 executable");
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), mode, "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.pipe(serverLog, { end: false });
  server.stderr.pipe(serverLog, { end: false });
  let serverError;
  server.on("error", (error) => { serverError = error; });
  const deadline = Date.now() + 120_000;
  while (true) {
    if (serverError) throw serverError;
    assert.equal(server.exitCode, null, "Production server exited; inspect server.log");
    const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Production server readiness timed out");
    await delay(500);
  }
  const versions = [];
  for (const target of [{ name: "103", executablePath: process.env.CHROME_103_PATH }, { name: "current" }]) {
    browser = await chromium.launch({ executablePath: target.executablePath });
    const version = browser.version();
    if (target.name === "103") assert.match(version, /^103\./, "Must use Chromium 103, not a spoofed User-Agent");
    versions.push({ browser: target.name, version });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", reducedMotion: "reduce" });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    if (target.name === "103") await checkOriginalRegression(page);
    await page.goto(`${base}/?session=${sessionId}`);
    await page.locator(".chat-input-textarea").waitFor();
    await checkTranscript(page);
    await page.locator(".chat-input-textarea").fill("A preserved draft in Chrome 103");
    await page.setViewportSize({ width: 1100, height: 500 });
    await checkTranscript(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await checkFilesPlacement(page);
    await showSidebarFiles(page);
    await page.getByTitle(join(project, "notes.txt").replace(/\\/g, "/"), { exact: true }).click();
    await page.locator("#file-panel").getByText("Chrome 103 file viewer", { exact: false }).waitFor();
    await page.locator("#file-panel").getByRole("button", { name: "Hide file panel", exact: true }).click();
    await checkSettings(page, target.name);
    await page.getByRole("button", { name: "Debug", exact: true }).click();
    const debug = page.getByRole("region", { name: "Debug: connections and server state", exact: true });
    await debug.waitFor();
    assert.ok((await debug.boundingBox()).height <= 500, "Debug panel remains bounded in a short window");
    await page.screenshot({ path: join(artifacts, `${target.name}-debug.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open another project…", exact: true }).click();
    const directory = page.getByRole("dialog", { name: "Select directory", exact: true });
    await assertReachable(directory.getByRole("button", { name: "Close", exact: true }));
    assert.ok((await directory.locator(".directory-picker-panel").boundingBox()).height <= 500, "Directory picker fits the viewport");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".chat-input-textarea").inputValue(), "A preserved draft in Chrome 103");
    await page.reload();
    await page.locator(".chat-input-textarea").waitFor();
    await checkTranscript(page);
    // 动态内联颜色与延迟加载样式都使用同一回退，主题变化后必须重新计算。
    await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.id = "compat-color-probe";
      document.body.append(probe);
    });
    const mix = rewriteCssValue("color-mix(in srgb, var(--accent) 50%, transparent)");
    await page.locator("#compat-color-probe").evaluate((element, value) => { element.style.backgroundColor = value; }, mix);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#compat-color-probe")).backgroundColor !== "rgba(0, 0, 0, 0)");
    const beforeColor = await page.locator("#compat-color-probe").evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => { document.documentElement.dataset.theme = "rose"; document.documentElement.classList.remove("dark"); });
    await page.waitForFunction((before) => getComputedStyle(document.querySelector("#compat-color-probe")).backgroundColor !== before, beforeColor);
    const lateMix = rewriteCssValue("color-mix(in srgb, var(--accent) 25%, transparent)");
    await page.addStyleTag({ content: `#compat-color-probe { border-top: 2px solid ${lateMix}; }` });
    await page.waitForFunction(() => {
      const style = getComputedStyle(document.querySelector("#compat-color-probe"));
      return style.borderTopWidth === "2px" && style.borderTopColor !== "rgba(0, 0, 0, 0)";
    });
    const insertedMix = rewriteCssValue("color-mix(in srgb, var(--accent) 75%, transparent)");
    await page.evaluate((value) => {
      const sheets = [...document.styleSheets];
      const sheet = sheets[sheets.length - 1];
      sheet.insertRule(`#compat-inserted-probe { background-color: ${value}; }`, sheet.cssRules.length);
      const probe = document.createElement("div");
      probe.id = "compat-inserted-probe";
      document.body.append(probe);
    }, insertedMix);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("#compat-inserted-probe")).backgroundColor !== "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(artifacts, `${target.name}-after.png`) });
    assert.deepEqual(errors, [], "Application must not throw browser errors");
    await context.tracing.stop({ path: join(artifacts, `${target.name}-trace.zip`) });
    await browser.close();
    browser = context = page = null;
    console.log(`PASS Windows Chromium ${version}: original regression, transcript, input, sidebar, files, all settings, themes and reload`);
  }
  writeFileSync(join(artifacts, "versions.json"), JSON.stringify(versions, null, 2));
} catch (error) {
  // 将实际错误写入 Actions annotation，公开运行页也可直接定位失败，无需读取凭据。
  const details = String(error.stack || error).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.error(`::error title=Windows browser regression::${details}`);
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  await context?.tracing.stop({ path: join(artifacts, "failure-trace.zip") }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
  serverLog.end();
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
