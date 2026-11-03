import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";

/**
 * 点击真实控件并等待指定 API 完成，返回浏览器实际发送的 JSON。
 * @param {import('playwright').Page} page 当前浏览器页面。
 * @param {string} path API 的绝对路径，不含查询参数。
 * @param {string} method 预期 HTTP 方法。
 * @param {() => Promise<unknown>} action 触发请求的真实界面操作。
 * @param {number} status 预期响应状态，失败重试场景显式指定非 200。
 * @param {string | undefined} commandType RPC 请求体的 type；同一路径可能同时有后台命令，等待 RPC 时必须指定。
 */
async function requestFromAction(page, path, method, action, status = 200, commandType) {
  if (path.startsWith("/api/agent/") && method === "POST") {
    assert.equal(typeof commandType, "string", "RPC waits must identify the expected command type");
  }
  const responsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === path && response.request().method() === method
      // get_tools 等后台命令与 reload 共用路径，必须先按请求载荷筛选再等待响应。
      && (commandType === undefined || response.request().postDataJSON()?.type === commandType));
  await action();
  const response = await responsePromise;
  assert.equal(response.status(), status, `${method} ${path} must return the expected status`);
  await response.finished();
  return response.request().postDataJSON();
}

/**
 * 返回设置详情中由可见字段标题定位的输入控件。
 * @param {import('playwright').Locator} surface 当前设置面板。
 * @param {string} label 字段标题的完整文本。
 * @param {string} selector 字段内部输入控件的 CSS 选择器。
 */
function fieldControl(surface, label, selector = "input") {
  return surface.locator(".config-field-label").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
    .locator("..").locator(selector);
}

/**
 * 在桌面或手机设置导航中切换区域，限定当前 Settings 对话框。
 * @param {import('playwright').Locator} settings Settings 对话框。
 * @param {string} section 设置区域值。
 * @param {string} label 桌面导航按钮的英文名称。
 */
async function selectSection(settings, section, label) {
  const select = settings.getByRole("combobox", { name: "Settings", exact: true });
  if (await select.isVisible()) await select.selectOption(section);
  else await settings.getByRole("button", { name: label, exact: true }).click();
}

/**
 * 打开供应商选择器，点击指定供应商卡片。
 * @param {import('playwright').Page} page 当前页面，选择器浮层挂在 body 上。
 * @param {import('playwright').Locator} settings Settings 对话框。
 * @param {RegExp} name 卡片可访问名称匹配规则。
 */
async function chooseProvider(page, settings, name) {
  await settings.getByRole("button", { name: "Add provider", exact: true }).click();
  const search = page.getByPlaceholder("Search providers…", { exact: true });
  await search.waitFor();
  const picker = search.locator("..").locator("..");
  await picker.getByRole("button", { name }).click();
  await search.waitFor({ state: "hidden" });
}

/**
 * 创建只服务本次测试的 SSE 源，保留真实 EventSource 和粘贴交互。
 * @param {Set<import('node:http').ServerResponse>} streams 正在等待 OAuth 提交的 SSE 响应集合。
 */
async function createOAuthFixture(streams) {
  const server = createServer((request, response) => {
    if (request.url !== "/oauth") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    // 保持连接，浏览器才能像真实登录流一样先编辑再提交粘贴内容。
    response.write(`data: ${JSON.stringify({ type: "prompt_request", token: "fixture-oauth-token", message: "Fixture authorization code", placeholder: "Fixture OAuth code" })}\n\n`);
    streams.add(response);
    response.on("close", () => streams.delete(response));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

/**
 * 用真实设置组件验证 Chrome 103 的主要配置流程，外部服务由本地路由 fixture 隔离。
 * @param {import('playwright').Page} page Chromium 103 的真实页面。
 * @param {{base:string,project:string,artifacts:string,sessionId:string,record:(id:string,detail:object)=>void}} options 基础地址、临时项目、截图目录、恢复会话和同步覆盖记录回调。
 */
export async function checkFullSiteSettings(page, { base, project, artifacts, sessionId, record }) {
  const browserMajor = page.context().browser().version().split(".")[0];
  const evidence = [];
  const streams = new Set();
  const oauthServer = await createOAuthFixture(streams);
  const oauthUrl = `http://127.0.0.1:${oauthServer.address().port}/oauth`;
  let trust = { requiresTrust: true, trusted: false, decision: false, inherited: false };
  let defaultModel = { provider: "openai-codex", modelId: "gpt-fixture" };
  let defaultThinkingLevel = null;
  const enabledModels = new Map([["openai-codex/gpt-fixture", true], ["openai-codex/gpt-fixture-second", true], ["relay/relay-original", true]]);
  let config = { providers: { relay: { baseUrl: "https://relay.example.invalid/v1", api: "openai-completions", models: [{ id: "relay-original", name: "Relay original" }] } } };
  let keyConfigured = false;
  let oauthLoggedIn = false;
  let profiles = [];
  let subagentSettings = { enabled: true, maxConcurrent: 4 };
  let cacheMissNotices = false;
  let toolSettings = { isWindows: true, powerShellEnabled: false, codemode: "automatic", codemodeMode: { value: "on" }, codemodeInlineBudget: {} };
  const counts = { extensions: 1, skills: 0, prompts: 0, themes: 0 };
  let packages = [];
  const skillPath = join(project, "fixtures", "chrome-settings", "SKILL.md");
  const secondSkillPath = join(project, "fixtures", "chrome-settings-secondary", "SKILL.md");
  const skills = [
    { name: "chrome-fixture", description: "Fixture skill instructions", filePath: skillPath, baseDir: join(project, "fixtures", "chrome-settings"), disableModelInvocation: false, sourceInfo: { source: "user", scope: "user" }, install: { package: "fixture/chrome-skills@compat", scope: "global", source: "fixture/chrome-skills", versionHash: "11111111", canCheckForUpdates: true } },
    { name: "chrome-fixture-secondary", description: "Second fixture skill", filePath: secondSkillPath, baseDir: join(project, "fixtures", "chrome-settings-secondary"), disableModelInvocation: false, sourceInfo: { source: "user", scope: "user" } },
  ];
  const mcpPath = join(project, "fixtures", "mcp.json");
  const projectMcpFile = { scope: "project", path: join(project, ".pi", "mcp.json"), exists: true, problems: [] };
  let servers = [];
  let removedServer;
  let flow;
  let failNextMcpTest = false;
  const requests = [];
  // 语言切换会改变 aria-label，使用对话框的稳定类名保持同一作用域。
  const settings = page.locator('.settings-dialog-backdrop[role="dialog"]');
  const detail = settings.locator(".config-detail:visible");
  const footer = settings.locator(".config-footer:visible");

  /** 记录已完成的实际动作；id 是稳定覆盖标识，actions 描述真实交互。 */
  function verified(id, actions) {
    const browserLocal = id === "settings.general.appearance-persistence" || id === "settings.general.language" || id === "settings.general.cross-tab-font-sync";
    const item = { mode: browserLocal ? "browser-local" : "mocked-service", service: browserLocal ? "real localStorage and browser rendering" : "controlled API fixtures; real browser components", actions };
    evidence.push({ id, ...item });
    record(id, item);
  }

  /** 返回当前插件状态；无参数，读取本测试闭包内的 packages。 */
  function pluginsOverview() {
    return { packages, standaloneExtensions: [], totals: packages.length ? counts : { extensions: 0, skills: 0, prompts: 0, themes: 0 }, diagnostics: [], projectResourcesLoaded: true };
  }

  /** 返回当前 MCP 配置状态；无参数，读取本次测试独立保存的服务列表。 */
  function mcpOverview() {
    return {
      mcp: { available: true },
      codemode: {
        preference: toolSettings.codemode, sandbox: { state: "available" }, builtinDisabled: false,
        mode: { ...toolSettings.codemodeMode, settingsPath: join(project, "fixtures", "settings.json") },
        inlineBudget: { ...toolSettings.codemodeInlineBudget, settingsPath: join(project, "fixtures", "settings.json"), default: 1000, max: 100000 },
      },
      files: [{ scope: "global", path: mcpPath, exists: true, problems: [] }, projectMcpFile],
      servers,
      project: { cwd: project, trust },
    };
  }

  /** 为指定状态构造 MCP 连接结果；state 表示是否已授权。 */
  function connectionResult(state = "connected") {
    return { state, tools: state === "connected" ? [{ name: "fixture_lookup", description: "Fixture lookup tool", readOnly: true, exposure: "direct" }] : [], toolCount: state === "connected" ? 1 : 0, durationMs: 12, testedAt: Date.now() };
  }

  /** 返回模型启用状态；无参数，读取浏览器实际写入的本测试模型开关。 */
  function enabledModelsOverview() {
    const providers = [
      { id: "openai-codex", name: "OpenAI Codex", kind: "builtin", models: [
        { id: "gpt-fixture", name: "GPT Fixture", ref: "openai-codex/gpt-fixture", contextWindow: config.providers["openai-codex"]?.modelOverrides?.["gpt-fixture"]?.contextWindow ?? 128000 },
        { id: "gpt-fixture-second", name: "GPT Fixture Second", ref: "openai-codex/gpt-fixture-second", contextWindow: 128000 },
      ] },
      { id: "relay", name: "relay", kind: "custom", models: [{ id: "relay-original", name: "Relay original", ref: "relay/relay-original", contextWindow: 128000 }] },
    ].map((provider) => {
      const models = provider.models.map((model) => ({ ...model, enabled: enabledModels.get(model.ref) }));
      return { ...provider, models, enabledCount: models.filter((model) => model.enabled).length };
    });
    const enabled = [...enabledModels].filter(([, value]) => value).map(([ref]) => ref);
    return { allEnabled: enabled.length === enabledModels.size, patterns: enabled.length === enabledModels.size ? null : enabled, stalePatterns: [], enabledTotal: enabled.length, availableTotal: enabledModels.size, scope: "global", settingsPath: join(project, "fixtures", "settings.json"), editable: true, providers };
  }

  /** 精确匹配本文件接管的 API；url 是 Playwright 传入的请求地址。 */
  function matchesFixture(url) {
    return url.pathname === `/api/agent/${encodeURIComponent(sessionId)}`
      || /^\/api\/(?:tools\/settings|project-trust|cache-miss-notices|models-config(?:\/(?:discover|test|catalog))?|auth\/(?:providers|api-key\/fixture-key|login\/fixture-oauth)|models(?:\/(?:enabled|default))?|provider-usage\/query|skills(?:\/(?:content|search|install|check|update))?|subagents\/(?:settings|profiles)|plugins(?:\/check)?|mcp(?:\/(?:test|sign-in(?:\/fixture-flow)?))?)$/.test(url.pathname);
  }

  /** 拦截独立服务边界；route 参数提供真实浏览器请求，界面和 React 均保持原实现。 */
  async function fixtureHandler(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();
    // 只隔离本测试点击的 reload；会话只读请求仍走真实应用，不能替换整个聊天组件。
    if (path === `/api/agent/${encodeURIComponent(sessionId)}` && (method !== "POST" || body?.type !== "reload")) return route.fallback();
    requests.push({ path, method, body, url: request.url() });
    let json;
    if (path === `/api/agent/${encodeURIComponent(sessionId)}`) {
      json = { success: true, data: null };
    } else if (path === "/api/tools/settings") {
      if (method === "PUT") {
        if ("enabled" in body) toolSettings = { ...toolSettings, powerShellEnabled: body.enabled };
        if ("codemode" in body) toolSettings = { ...toolSettings, codemode: body.codemode };
        if ("codemodeMode" in body) toolSettings = { ...toolSettings, codemodeMode: { value: body.codemodeMode } };
        if ("codemodeInlineBudget" in body) toolSettings = { ...toolSettings, codemodeInlineBudget: body.codemodeInlineBudget === null ? {} : { value: body.codemodeInlineBudget } };
      }
      json = toolSettings;
    } else if (path === "/api/project-trust") {
      if (method === "POST") trust = { requiresTrust: true, trusted: true, decision: true, inherited: false };
      json = { ...trust, mcpFile: projectMcpFile, mcpServers: [] };
    } else if (path === "/api/cache-miss-notices") {
      if (method === "PUT") cacheMissNotices = body.enabled;
      json = { enabled: cacheMissNotices };
    } else if (path === "/api/models-config") {
      if (method === "PUT") config = body;
      json = method === "PUT" ? { success: true } : config;
    } else if (path === "/api/models-config/discover") {
      json = { models: [{ id: "chrome-discovered", name: "Chrome discovered" }], endpoint: "https://relay.example.invalid/v1/models" };
    } else if (path === "/api/models-config/test") {
      json = { ok: true, status: 200, latencyMs: 12, responseText: "fixture model response" };
    } else if (path === "/api/models-config/catalog") {
      json = { providers: [] };
    } else if (path === "/api/auth/providers") {
      json = { oauthProviders: [{ id: "openai-codex", name: "OpenAI Codex", loggedIn: true }, { id: "fixture-oauth", name: "Fixture OAuth", loggedIn: oauthLoggedIn }], apiKeyProviders: [{ id: "fixture-key", displayName: "Fixture Key", configured: keyConfigured, modelCount: 1 }] };
    } else if (path === "/api/auth/api-key/fixture-key") {
      keyConfigured = method === "POST";
      json = { success: true };
    } else if (path === "/api/auth/login/fixture-oauth") {
      if (method === "GET") return route.fulfill({ status: 307, headers: { location: oauthUrl } });
      oauthLoggedIn = true;
      json = { success: true };
      // 提交完成后由真实 SSE 发出成功，覆盖组件从粘贴到已登录的完整状态转换。
      for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "success" })}\n\n`);
    } else if (path === "/api/models/enabled") {
      if (method === "PUT") {
        if (body.op === "models") for (const ref of body.refs) enabledModels.set(ref, body.enabled);
        if (body.op === "provider") for (const ref of enabledModels.keys()) if (ref.startsWith(`${body.provider}/`)) enabledModels.set(ref, body.enabled);
        if (body.op === "clear") for (const ref of enabledModels.keys()) enabledModels.set(ref, true);
      }
      json = enabledModelsOverview();
    } else if (path === "/api/models/default") {
      if ("thinkingLevel" in body) defaultThinkingLevel = body.thinkingLevel;
      else defaultModel = { provider: body.provider, modelId: body.modelId };
      json = { success: true };
    } else if (path === "/api/models") {
      json = {
        models: { "openai-codex:gpt-fixture": "GPT Fixture", "openai-codex:gpt-fixture-second": "GPT Fixture Second" },
        modelList: [{ provider: "openai-codex", id: "gpt-fixture", name: "GPT Fixture", input: ["text"] }, { provider: "openai-codex", id: "gpt-fixture-second", name: "GPT Fixture Second", input: ["text"] }],
        defaultModel,
        defaultThinkingLevel, savedDefaultThinkingLevel: defaultThinkingLevel,
        thinkingLevels: { "openai-codex:gpt-fixture": ["off", "low", "medium", "high"], "openai-codex:gpt-fixture-second": ["off", "low", "medium", "high"] },
        thinkingLevelMaps: {}, thinkingLevelPins: {},
      };
    } else if (path === "/api/provider-usage/query") {
      json = { providers: [] };
    } else if (path === "/api/skills") {
      if (method === "PATCH") {
        const targets = body.filePaths ?? [body.filePath];
        for (const skill of skills) if (targets.includes(skill.filePath)) skill.disableModelInvocation = body.disableModelInvocation;
      }
      json = method === "PATCH" ? (body.filePaths ? { results: body.filePaths.map((filePath) => ({ filePath })) } : { success: true }) : { skills, diagnostics: [], projectResourcesLoaded: true };
    } else if (path === "/api/skills/content") {
      json = { content: url.searchParams.has("document") ? "# Fixture reference\n\nChrome reference contents." : "---\nname: chrome-fixture\n---\n# Fixture instructions\n\nChrome skill contents.\n\n[Open fixture reference](reference.md)" };
    } else if (path === "/api/skills/search") {
      json = { results: [{ package: "fixture/chrome-skills@compat", installs: "42", url: "https://skills.example.invalid/compat" }] };
    } else if (path === "/api/skills/install") {
      json = { success: true };
    } else if (path === "/api/skills/check") {
      json = { updates: [{ package: "fixture/chrome-skills@compat", scope: "global", state: "update-available", currentVersion: skills[0].install.versionHash, latestVersion: "22222222" }] };
    } else if (path === "/api/skills/update") {
      skills[0].install.versionHash = "22222222";
      json = { success: true, skill: skills[0] };
    } else if (path === "/api/subagents/settings") {
      if (method === "PUT") subagentSettings = { ...subagentSettings, ...body };
      json = subagentSettings;
    } else if (path === "/api/subagents/profiles") {
      if (method === "PUT") {
        const profile = { ...body.profile, scope: body.scope, filePath: join(project, "fixtures", `${body.profile.name}.md`) };
        profiles = [...profiles.filter((item) => item.name !== profile.name), profile];
        json = { profile };
      } else if (method === "DELETE") {
        profiles = profiles.filter((item) => item.name !== body.name || item.scope !== body.scope);
        json = { success: true };
      } else json = { profiles };
    } else if (path === "/api/plugins") {
      if (method === "POST") {
        if (body.action === "install") packages.push({ source: body.source, scope: body.scope, packageName: "chrome-plugin", installedPath: join(project, "fixtures", "chrome-plugin"), version: "1.0.0", description: "Fixture package", disabled: true, filtered: false, canCheckForUpdates: true, counts, resources: [{ kind: "extension", name: "chrome-extension", path: join(project, "fixtures", "extension.ts"), relativePath: "extension.ts" }], status: "disabled" });
        const pkg = packages.find((item) => item.source === body.source);
        for (const item of packages) {
          if (item.source !== body.source && !body.packages?.some((target) => target.source === item.source && target.scope === item.scope)) continue;
          if (body.action === "enable") Object.assign(item, { disabled: false, status: "loaded" });
          if (body.action === "disable") Object.assign(item, { disabled: true, status: "disabled" });
        }
        if (body.action === "update" && pkg) pkg.version = "1.1.0";
        if (body.action === "update" && !body.source) for (const item of packages) item.version = "1.2.0";
        if (body.action === "remove") packages = packages.filter((item) => item.source !== body.source);
      }
      json = pluginsOverview();
      if (body?.packages) json.results = body.packages.map((item) => ({ source: item.source, scope: item.scope }));
    } else if (path === "/api/plugins/check") {
      json = { updates: [{ source: packages[0].source, scope: "global", displayName: "chrome-plugin", type: "npm", state: "update-available" }] };
    } else if (path === "/api/mcp") {
      const extra = {};
      if (method === "POST") {
        if (body.action === "add") {
          servers = [{ name: "chrome-mcp", scope: "global", sourcePath: mcpPath, configKey: "fixture-config-key", enabled: true, validated: true, transport: "http", exposure: "direct", url: "https://mcp.example.invalid/fixture", envNames: [], headerNames: [], usesOAuth: true, signedIn: false, commandFields: [], variableReferences: [], masked: false }];
          extra.added = { scope: "global", name: "chrome-mcp", path: mcpPath };
        }
        if (["enable", "disable"].includes(body.action)) servers[0].enabled = body.action === "enable";
        if (body.action === "set-enabled") {
          for (const server of servers) if (body.servers.some((target) => target.name === server.name && target.scope === server.scope)) server.enabled = body.enabled;
          extra.results = body.servers;
        }
        if (body.action === "set-exposure") servers[0].exposure = body.exposure;
        if (body.action === "sign-out") {
          Object.assign(servers[0], { signedIn: false, oauthStateStored: false });
          delete servers[0].status;
          extra.signedOut = { scope: "global", name: "chrome-mcp", removed: true };
        }
        if (body.action === "remove") {
          removedServer = servers[0];
          servers = [];
          extra.undo = { scope: "global", name: "chrome-mcp", path: mcpPath, token: "fixture-undo-token", expiresInMs: 60000 };
        }
        if (body.action === "undo") {
          servers = [removedServer];
          extra.restored = { scope: "global", name: "chrome-mcp" };
        }
      }
      json = { ...mcpOverview(), ...extra };
    } else if (path === "/api/mcp/test") {
      if (failNextMcpTest) {
        failNextMcpTest = false;
        return route.fulfill({ status: 503, json: { error: "Fixture MCP temporarily unavailable", reason: "internal" } });
      }
      const result = connectionResult(servers[0].signedIn ? "connected" : "needs-auth");
      servers[0].status = { origin: "test", ...result };
      json = { scope: "global", name: "chrome-mcp", configKey: "fixture-config-key", result };
    } else if (path === "/api/mcp/sign-in") {
      servers[0].oauthStateStored = true;
      flow = { scope: "global", name: "chrome-mcp", flowId: "fixture-flow", configKey: "fixture-config-key", phase: "authorize", authorizationUrl: "https://login.example.invalid/authorize", redirectUrl: "http://127.0.0.1:1455/callback", expiresInMs: 300000 };
      json = flow;
    } else if (path === "/api/mcp/sign-in/fixture-flow") {
      if (method === "POST") {
        const result = { ...connectionResult(), afterSignIn: true };
        flow = { ...flow, phase: "done", expiresInMs: 0, result };
        Object.assign(servers[0], { signedIn: true, oauthStateStored: true, status: { origin: "test", ...result } });
      }
      if (method === "DELETE") flow = { ...flow, phase: "cancelled", expiresInMs: 0 };
      json = flow;
    }
    return route.fulfill({ json });
  }

  await page.route(matchesFixture, fixtureHandler);
  try {
    await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
    const sidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await sidebar.isVisible()) await sidebar.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await selectSection(settings, "general", "General");
    const general = settings.locator(".settings-general:visible");
    const uiFont = general.getByRole("textbox", { name: "Interface font", exact: true });
    const monoFont = general.getByRole("textbox", { name: "Monospace font", exact: true });
    await uiFont.fill("serif");
    await monoFont.fill("monospace");
    await general.getByRole("slider", { name: "Interface font weight", exact: true }).press("End");
    await general.getByRole("slider", { name: "Monospace font weight", exact: true }).press("End");
    await general.getByRole("slider", { name: "Chat content width", exact: true }).press("End");
    await general.getByRole("slider", { name: "Chat & terminal font size", exact: true }).press("End");
    await page.waitForFunction(() => getComputedStyle(document.body).fontFamily.startsWith("serif,") && getComputedStyle(document.body).fontWeight === "600");
    assert.deepEqual(await page.evaluate(() => ({
      ui: localStorage.getItem("pi-ui-font-family"), mono: localStorage.getItem("pi-mono-font-family"),
      uiWeight: localStorage.getItem("pi-ui-font-weight"), monoWeight: localStorage.getItem("pi-mono-font-weight"),
      width: localStorage.getItem("pi-chat-content-width"), size: localStorage.getItem("pi-chat-content-font-size"),
      appliedWidth: document.documentElement.style.getPropertyValue("--chat-content-max-width"),
      appliedSize: document.documentElement.style.getPropertyValue("--chat-content-font-size"),
    })), { ui: "serif", mono: "monospace", uiWeight: "600", monoWeight: "600", width: "2000", size: "24", appliedWidth: "2000px", appliedSize: "24px" });
    await general.locator('input[name="enter-send-mode"][value="ctrlEnter"]').locator("..").click();
    await general.locator('input[name="files-placement"][value="tab"]').locator("..").click();
    await general.getByRole("radio", { name: "Dark", exact: true }).locator("..").click();
    assert.deepEqual(await page.evaluate(() => ({ send: localStorage.getItem("pi-enter-send-mode"), files: localStorage.getItem("pi-web:sidebar-files-placement"), theme: localStorage.getItem("pi-theme"), applied: document.documentElement.dataset.theme })), { send: "ctrlEnter", files: "tab", theme: "dark", applied: "dark" });
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    const reopenedSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await reopenedSidebar.isVisible()) await reopenedSidebar.click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await selectSection(settings, "general", "General");
    assert.equal(await uiFont.inputValue(), "serif");
    assert.equal(await monoFont.inputValue(), "monospace");
    assert.equal(await general.getByRole("slider", { name: "Chat content width", exact: true }).inputValue(), "2000");
    assert.equal(await general.getByRole("slider", { name: "Chat & terminal font size", exact: true }).inputValue(), "24");
    assert.equal(await general.locator('input[name="enter-send-mode"][value="ctrlEnter"]').isChecked(), true);
    assert.equal(await general.locator('input[name="files-placement"][value="tab"]').isChecked(), true);
    assert.equal(await general.getByRole("radio", { name: "Dark", exact: true }).isChecked(), true);
    await page.screenshot({ path: join(artifacts, `${browserMajor}-settings-general-functional.png`) });
    verified("settings.general.appearance-persistence", "Edited interface/monospace fonts and weights, keyboard-adjusted width/size sliders, changed send key/file placement/theme, asserted stored and applied values, then reloaded and verified all selected controls persisted.");
    const sibling = await page.context().newPage();
    try {
      await sibling.goto(`${base}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
      await sibling.locator(".chat-input-textarea").waitFor();
      await uiFont.fill("monospace");
      const uiWeight = general.getByRole("slider", { name: "Interface font weight", exact: true });
      await uiWeight.press("Home");
      await uiWeight.press("ArrowRight");
      await uiWeight.press("ArrowRight");
      await sibling.waitForFunction(() => getComputedStyle(document.body).fontFamily.startsWith("monospace,") && getComputedStyle(document.body).fontWeight === "300");
      assert.deepEqual(await sibling.evaluate(() => ({ family: localStorage.getItem("pi-ui-font-family"), weight: localStorage.getItem("pi-ui-font-weight") })), { family: "monospace", weight: "300" });
      await uiFont.fill("serif");
      await uiWeight.press("End");
      await sibling.waitForFunction(() => getComputedStyle(document.body).fontFamily.startsWith("serif,") && getComputedStyle(document.body).fontWeight === "600");
      verified("settings.general.cross-tab-font-sync", "Opened a second real application tab, edited font family/weight in Settings and verified storage-event updates in the sibling's computed styles and localStorage, then restored both values.");
    } finally {
      await sibling.close();
    }
    await general.getByRole("radio", { name: /^简体中文/ }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-locale")), "zh-CN");
    await settings.locator(".settings-dialog-title").filter({ hasText: /^设置$/ }).waitFor();
    await general.getByRole("radio", { name: /^English/ }).click();
    await settings.locator(".settings-dialog-title").filter({ hasText: /^Settings$/ }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-locale")), "en");
    verified("settings.general.language", "Changed to Simplified Chinese, asserted persisted locale and translated navigation, then switched back to English and verified its persisted value.");
    const cacheSave = await requestFromAction(page, "/api/cache-miss-notices", "PUT", () => general.getByRole("switch", { name: "Show cache and cost notices", exact: true }).click());
    assert.deepEqual(cacheSave, { enabled: true });
    await general.locator('[role="switch"][aria-label="Show cache and cost notices"][aria-checked="true"]').waitFor();
    assert.equal(await general.getByRole("switch", { name: "Show cache and cost notices", exact: true }).getAttribute("aria-checked"), "true");
    verified("settings.general.cache-notices", "Saved cache/cost notices through its real server-backed switch and asserted the exact enabled mutation and checked state.");
    const powerShellReload = await requestFromAction(page, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", async () => {
      const powerShellSave = await requestFromAction(page, "/api/tools/settings", "PUT", () => general.getByRole("switch", { name: "Use PowerShell instead of Bash", exact: true }).click());
      assert.deepEqual(powerShellSave, { enabled: true });
    }, 200, "reload");
    assert.deepEqual(powerShellReload, { type: "reload" });
    await general.locator('[role="switch"][aria-label="Use PowerShell instead of Bash"][aria-checked="true"]').waitFor();
    verified("settings.general.powershell", "Saved the Windows PowerShell option, asserted enabled:true and the ensuing session reload command, then verified its checked state; the process reload was mocked.");
    await general.getByRole("button", { name: "Reset interface font", exact: true }).click();
    await general.getByRole("button", { name: "Reset monospace font", exact: true }).click();
    await general.getByRole("button", { name: "Reset chat content width", exact: true }).click();
    await general.getByRole("button", { name: "Reset chat & terminal font size", exact: true }).click();
    await general.locator('input[name="enter-send-mode"][value="enter"]').locator("..").click();
    await general.locator('input[name="files-placement"][value="below"]').locator("..").click();
    await general.getByRole("radio", { name: "System", exact: true }).locator("..").click();

    // 从 Settings 中的真实信任入口打开堆叠对话框，确认后才允许项目范围保存。
    await selectSection(settings, "mcp", "MCP");
    await settings.getByRole("button", { name: "Trust project…", exact: true }).click();
    const trustDialog = page.getByRole("dialog", { name: "Trust this project?", exact: true });
    await trustDialog.getByText("The file declares no servers.", { exact: true }).waitFor();
    assert.ok(requests.some((item) => item.path === "/api/project-trust" && new URL(item.url).searchParams.get("cwd") === project));
    const trustSave = await requestFromAction(page, "/api/project-trust", "POST", () => trustDialog.getByRole("button", { name: "Trust project", exact: true }).click());
    assert.deepEqual(trustSave, { cwd: project });
    await trustDialog.waitFor({ state: "hidden" });
    await settings.getByRole("button", { name: "Trust project…", exact: true }).waitFor({ state: "hidden" });
    verified("settings.project.trust-confirm", "Opened the MCP Trust project entry above Settings, read the project's declared server listing, confirmed trust and asserted the exact project path plus dismissed trust controls.");
    await settings.getByRole("button", { name: "Code mode: Automatic", exact: true }).click();
    const codeModeChoice = detail.getByRole("group", { name: "Code mode", exact: true });
    const codeModeSave = await requestFromAction(page, "/api/tools/settings", "PUT", () => codeModeChoice.getByRole("button", { name: "Always on", exact: true }).click());
    assert.deepEqual(codeModeSave, { codemode: "always" });
    await codeModeChoice.locator('button[aria-pressed="true"]').filter({ hasText: /^Always on$/ }).waitFor();
    const builtInMode = detail.getByRole("group", { name: "Built-in tools", exact: true });
    const builtInModeSave = await requestFromAction(page, "/api/tools/settings", "PUT", () => builtInMode.getByRole("button", { name: "In scripts", exact: true }).click());
    assert.deepEqual(builtInModeSave, { codemodeMode: "only" });
    await builtInMode.locator('button[aria-pressed="true"]').filter({ hasText: /^In scripts$/ }).waitFor();
    const budget = detail.getByRole("textbox", { name: "Tool list budget", exact: true });
    await budget.fill("1200");
    const budgetSave = await requestFromAction(page, "/api/tools/settings", "PUT", () => detail.locator(".mcp-codemode-budget").getByRole("button", { name: "Save", exact: true }).click());
    assert.deepEqual(budgetSave, { codemodeInlineBudget: 1200 });
    assert.equal(toolSettings.codemodeInlineBudget.value, 1200);
    await page.waitForFunction(() => {
      const input = document.querySelector('.settings-section-host:not([hidden]) .mcp-codemode-budget-input');
      return input?.value === "1200" && !input.readOnly && input.form.querySelector("button").disabled;
    });
    verified("settings.mcp.code-mode-settings", "Saved Code mode Always on, Built-in tools In scripts and its numeric tool budget; asserted all three independent tools/settings payloads and selected/saved controls.");
    await selectSection(settings, "models", "Models");

    // 自定义供应商和模型都通过真实编辑器创建，持久化断言使用浏览器提交的 JSON。
    await chooseProvider(page, settings, /^OpenAI \/ Anthropic compatible/);
    await detail.getByPlaceholder("provider-name", { exact: true }).fill("chrome-provider");
    await detail.getByRole("button", { name: "Rename", exact: true }).click();
    await detail.getByPlaceholder("https://api.example.com/v1", { exact: true }).fill("https://chrome.example.invalid/v1");
    await settings.locator(".config-sidebar-item").filter({ hasText: /^chrome-provider$/ }).locator("..").getByRole("button", { name: "+ Model", exact: true }).click();
    await detail.getByPlaceholder("model-id", { exact: true }).fill("chrome-model");
    await fieldControl(detail, "Name").fill("Chrome model");
    await detail.getByPlaceholder("128000", { exact: true }).fill("256000");
    await detail.getByPlaceholder("16384", { exact: true }).fill("8192");
    const modelSave = await requestFromAction(page, "/api/models-config", "PUT", () => footer.getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(modelSave.providers["chrome-provider"].baseUrl, "https://chrome.example.invalid/v1");
    assert.deepEqual(modelSave.providers["chrome-provider"].models[0], { id: "chrome-model", name: "Chrome model", contextWindow: 256000, maxTokens: 8192 });
    await footer.getByRole("button", { name: "Saved", exact: true }).waitFor();
    verified("settings.models.custom-save", "Created and renamed a provider, added a model, edited token limits and asserted the exact saved model JSON.");

    await detail.getByRole("button", { name: "Edit prices", exact: true }).click();
    await fieldControl(detail, "Input").fill("1.25");
    await fieldControl(detail, "Output").fill("2.5");
    await fieldControl(detail, "Cache read").fill("0.25");
    await fieldControl(detail, "Cache write").fill("0.5");
    await detail.getByRole("button", { name: "Done", exact: true }).click();
    await detail.getByRole("checkbox", { name: "Reasoning / thinking", exact: true }).check();
    await detail.getByRole("checkbox", { name: "Image input", exact: true }).check();
    await detail.getByRole("button", { name: /^Advanced settings/ }).click();
    const advanced = detail.locator("#model-advanced-settings");
    await fieldControl(advanced, "Base URL override").fill("https://model.example.invalid/v1");
    await fieldControl(advanced, "API override", "select").selectOption("openai-responses");
    await advanced.getByRole("button", { name: "+ Add header", exact: true }).click();
    await advanced.getByPlaceholder("Header-Name", { exact: true }).fill("X-Chrome-Test");
    await advanced.getByPlaceholder("value", { exact: true }).fill("fixture-header-value");
    await fieldControl(advanced, "Image size limit (bytes)").fill("4194304");
    await advanced.getByRole("checkbox", { name: "DeepSeek thinking compatibility", exact: true }).check();
    await advanced.getByRole("checkbox", { name: "Use the developer role for the system prompt", exact: true }).uncheck();
    const advancedSave = await requestFromAction(page, "/api/models-config", "PUT", () => footer.getByRole("button", { name: "Save", exact: true }).click());
    const advancedModel = advancedSave.providers["chrome-provider"].models[0];
    assert.deepEqual(advancedModel.cost, { input: 1.25, output: 2.5, cacheRead: 0.25, cacheWrite: 0.5 });
    assert.equal(advancedModel.baseUrl, "https://model.example.invalid/v1");
    assert.equal(advancedModel.api, "openai-responses");
    assert.deepEqual(advancedModel.headers, { "X-Chrome-Test": "fixture-header-value" });
    assert.deepEqual(advancedModel.input, ["text", "image"]);
    assert.equal(advancedModel.reasoning, true);
    assert.deepEqual(advancedModel.inputLimits, { images: { resize: { maxBytes: 4194304 } } });
    assert.deepEqual(advancedModel.compat, { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, supportsDeveloperRole: false });
    await footer.getByRole("button", { name: "Saved", exact: true }).waitFor();
    verified("settings.models.advanced-editor", "Edited all four prices, capabilities, model URL/API/header overrides, image byte limit and compatibility flags through real controls; asserted their exact saved model fields.");

    const testRequest = await requestFromAction(page, "/api/models-config/test", "POST", () => detail.getByRole("button", { name: "Test", exact: true }).click());
    assert.equal(testRequest.providerName, "chrome-provider");
    assert.equal(testRequest.model.id, "chrome-model");
    assert.equal(testRequest.provider.baseUrl, "https://chrome.example.invalid/v1");
    await detail.getByRole("button", { name: "OK", exact: true }).waitFor();
    verified("settings.models.connection-test", "Ran Test from the model editor, asserted model/provider payload and observed its successful OK state; model response was mocked.");

    await settings.locator(".config-sidebar-item").filter({ hasText: /^chrome-provider$/ }).click();
    const discovery = await requestFromAction(page, "/api/models-config/discover", "POST", () => detail.getByRole("button", { name: "Import models…", exact: true }).click());
    assert.equal(discovery.providerName, "chrome-provider");
    assert.equal(discovery.provider.baseUrl, "https://chrome.example.invalid/v1");
    assert.equal(discovery.provider.models, undefined);
    await detail.getByRole("checkbox", { name: /Chrome discovered/ }).check();
    await detail.getByRole("button", { name: "Add selected (1)", exact: true }).click();
    const discoverySave = await requestFromAction(page, "/api/models-config", "PUT", () => footer.getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(discoverySave.providers["chrome-provider"].models[1].id, "chrome-discovered");
    await settings.locator(".models-sidebar-indented-item").filter({ hasText: /^Chrome discovered$/ }).waitFor();
    verified("settings.models.discovery-import", "Imported the discovered model through its checkbox and Add selected, then asserted the persisted discovered model id.");

    await settings.locator(".config-sidebar-item").filter({ hasText: /^OpenAI Codex$/ }).click();
    const context = detail.getByRole("textbox", { name: "Context window for GPT Fixture", exact: true });
    await context.fill("512000");
    const contextSave = await requestFromAction(page, "/api/models-config", "PUT", () => footer.getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(contextSave.providers["openai-codex"].modelOverrides["gpt-fixture"].contextWindow, 512000);
    assert.equal(contextSave.providers["chrome-provider"].models.length, 2);
    await footer.getByRole("button", { name: "Saved", exact: true }).waitFor();
    verified("settings.models.context-window", "Changed a managed account context window and asserted its override plus preservation of custom models.");

    const modelSwitch = detail.getByRole("switch", { name: "Show GPT Fixture in the model selector", exact: true });
    const modelDisable = await requestFromAction(page, "/api/models/enabled", "PUT", () => modelSwitch.click());
    assert.deepEqual(modelDisable, { op: "models", refs: ["openai-codex/gpt-fixture"], enabled: false, cwd: project });
    await detail.locator('[role="switch"][aria-label="Show GPT Fixture in the model selector"][aria-checked="false"]').waitFor();
    const modelEnable = await requestFromAction(page, "/api/models/enabled", "PUT", () => modelSwitch.click());
    assert.deepEqual(modelEnable, { op: "models", refs: ["openai-codex/gpt-fixture"], enabled: true, cwd: project });
    await detail.locator('[role="switch"][aria-label="Show GPT Fixture in the model selector"][aria-checked="true"]').waitFor();
    const providerDisable = await requestFromAction(page, "/api/models/enabled", "PUT", () => detail.getByRole("button", { name: "Disable all", exact: true }).click());
    assert.deepEqual(providerDisable, { op: "provider", provider: "openai-codex", enabled: false, cwd: project });
    await detail.locator('.enabled-models-row [role="switch"][aria-checked="true"]').first().waitFor({ state: "hidden" });
    const providerEnable = await requestFromAction(page, "/api/models/enabled", "PUT", () => detail.getByRole("button", { name: "Enable all", exact: true }).click());
    assert.deepEqual(providerEnable, { op: "provider", provider: "openai-codex", enabled: true, cwd: project });
    await detail.locator('[role="switch"][aria-label="Show GPT Fixture Second in the model selector"][aria-checked="true"]').waitFor();
    verified("settings.models.enabled-switches", "Disabled/re-enabled a model and all models of its provider; asserted explicit model refs/provider/cwd and both models' resulting switch states while preserving another provider.");

    await chooseProvider(page, settings, /^Fixture Key/);
    await detail.getByPlaceholder("sk-…", { exact: true }).fill("fixture-api-key-value");
    const keySave = await requestFromAction(page, "/api/auth/api-key/fixture-key", "POST", () => detail.getByRole("button", { name: "Save", exact: true }).click());
    assert.deepEqual(keySave, { apiKey: "fixture-api-key-value" });
    await detail.getByRole("button", { name: "Disconnect", exact: true }).waitFor();
    verified("settings.models.api-key", "Saved a fixture API key, asserted its exact POST body and observed configured Disconnect controls; no credential store was touched.");

    await chooseProvider(page, settings, /^Fixture OAuth/);
    await detail.getByRole("button", { name: "Login", exact: true }).click();
    const code = detail.getByPlaceholder("Fixture OAuth code", { exact: true });
    await code.fill("  fixture-authorization-code  ");
    const oauthPaste = await requestFromAction(page, "/api/auth/login/fixture-oauth", "POST", () => detail.getByRole("button", { name: "Submit", exact: true }).click());
    assert.deepEqual(oauthPaste, { token: "fixture-oauth-token", code: "fixture-authorization-code" });
    await detail.getByText("Connected successfully.", { exact: true }).waitFor();
    verified("settings.models.oauth-paste", "Used the real EventSource login flow, pasted and submitted a code, asserted its token/code POST and observed Connected successfully via local SSE.");

    await selectSection(settings, "skills", "Skills");
    await settings.locator(".config-sidebar-item").filter({ hasText: /^chrome-fixture$/ }).click();
    await detail.getByText("Chrome skill contents.", { exact: true }).waitFor();
    assert.ok(requests.some((item) => item.path === "/api/skills/content" && new URL(item.url).searchParams.get("filePath") === skillPath));
    await detail.getByRole("link", { name: "Open fixture reference", exact: true }).click();
    await detail.getByText("Chrome reference contents.", { exact: true }).waitFor();
    assert.ok(requests.some((item) => item.path === "/api/skills/content" && new URL(item.url).searchParams.get("document") === "reference.md"));
    await detail.getByRole("button", { name: "Back", exact: true }).click();
    await detail.getByText("Chrome skill contents.", { exact: true }).waitFor();
    verified("settings.skills.detail-navigation", "Loaded real rendered skill Markdown, opened its reference document and used Back to restore the root instructions.");
    const skillVersionCheck = await requestFromAction(page, "/api/skills/check", "POST", () => detail.getByRole("button", { name: "Check", exact: true }).click());
    assert.deepEqual(skillVersionCheck, { cwd: project, package: "fixture/chrome-skills@compat", scope: "global" });
    await detail.getByText("22222222", { exact: true }).waitFor();
    const skillUpdate = await requestFromAction(page, "/api/skills/update", "POST", () => detail.getByRole("button", { name: "Update", exact: true }).click());
    assert.deepEqual(skillUpdate, { cwd: project, package: "fixture/chrome-skills@compat", scope: "global" });
    await detail.getByText("Up to date", { exact: true }).waitFor();
    await detail.getByText("22222222", { exact: true }).waitFor();
    assert.equal(skills[0].install.versionHash, "22222222");
    verified("settings.skills.version-update", "Checked the installed skill version, applied its offered update and verified Up to date plus the new version hash; asserted exact package/scope/cwd requests and mocked the installer.");
    const toggle = await requestFromAction(page, "/api/skills", "PATCH", () => detail.getByRole("switch", { name: "Visible in model prompt — click to disable", exact: true }).click());
    assert.deepEqual(toggle, { filePath: skillPath, disableModelInvocation: true });
    await detail.getByRole("switch", { name: "Hidden from model prompt — click to enable", exact: true }).waitFor();
    verified("settings.skills.visibility", "Disabled a skill through its detail switch, asserted the file path/frontmatter flag and observed the enable control.");
    const skillsHost = settings.locator('.settings-section-host:not([hidden])');
    const skillGroupEnable = await requestFromAction(page, "/api/skills", "PATCH", () => skillsHost.getByRole("switch", { name: "Show every skill in global in the model prompt", exact: true }).click());
    assert.deepEqual(skillGroupEnable, { filePaths: [skillPath], disableModelInvocation: false });
    const groupHideName = "Hide every skill in global from the model prompt. They stay manually invocable.";
    await skillsHost.getByRole("switch", { name: groupHideName, exact: true }).waitFor();
    const skillGroupDisable = await requestFromAction(page, "/api/skills", "PATCH", () => skillsHost.getByRole("switch", { name: groupHideName, exact: true }).click());
    assert.deepEqual(skillGroupDisable, { filePaths: [skillPath, secondSkillPath], disableModelInvocation: true });
    await skillsHost.getByRole("switch", { name: "Show every skill in global in the model prompt", exact: true }).waitFor();
    assert.equal(skills.every((skill) => skill.disableModelInvocation), true);
    verified("settings.skills.group-switch", "Enabled a partly hidden skill group and then hid both skills; asserted only changed file paths were submitted and the whole group reached its requested state.");
    await settings.getByRole("button", { name: "Add skill", exact: true }).click();
    await detail.getByRole("group", { name: "Save to", exact: true }).getByRole("button", { name: "project", exact: true }).click();
    await detail.getByPlaceholder("e.g. react, testing, deploy", { exact: true }).fill("chrome compatibility");
    const search = await requestFromAction(page, "/api/skills/search", "POST", () => detail.getByRole("button", { name: "Search", exact: true }).click());
    assert.deepEqual(search, { query: "chrome compatibility" });
    const install = await requestFromAction(page, "/api/skills/install", "POST", () => detail.getByRole("button", { name: "Install", exact: true }).click());
    assert.deepEqual(install, { package: "fixture/chrome-skills@compat", scope: "project", cwd: project });
    await detail.getByRole("button", { name: "✓ Installed", exact: true }).waitFor();
    verified("settings.skills.search-install", "Searched the skills catalog, chose the trusted project save target, installed the returned package and asserted query/package/project scope/cwd plus Installed; installation was mocked.");

    await selectSection(settings, "agents", "Sub-agents");
    await settings.getByRole("button", { name: "New sub-agent", exact: true }).click();
    await detail.getByRole("textbox", { name: "Sub-agent ID", exact: true }).fill("chrome-agent");
    await detail.getByRole("textbox", { name: "Display name", exact: true }).fill("Chrome Agent");
    await detail.getByRole("textbox", { name: "Description", exact: true }).fill("Chrome browser test agent");
    await detail.getByRole("textbox", { name: "System instructions", exact: true }).fill("Read the fixture and report compatibility.");
    await detail.getByRole("combobox", { name: "Thinking", exact: true }).selectOption("high");
    await detail.getByRole("spinbutton", { name: "Max turns", exact: true }).fill("7");
    const agentCreate = await requestFromAction(page, "/api/subagents/profiles", "PUT", () => footer.getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(agentCreate.cwd, project);
    assert.equal(agentCreate.scope, "global");
    assert.equal(agentCreate.profile.name, "chrome-agent");
    assert.equal(agentCreate.profile.thinking, "high");
    assert.equal(agentCreate.profile.maxTurns, 7);
    await settings.locator(".config-sidebar-item").filter({ hasText: /^Chrome Agent$/ }).waitFor();
    assert.equal(await detail.getByRole("textbox", { name: "System instructions", exact: true }).inputValue(), "Read the fixture and report compatibility.");
    verified("settings.agents.create-save", "Created a sub-agent with prompt, thinking and turn limit; asserted its saved profile and loaded editor values.");
    await detail.getByRole("textbox", { name: "Description", exact: true }).fill("Edited Chrome agent");
    const agentEdit = await requestFromAction(page, "/api/subagents/profiles", "PUT", () => footer.getByRole("button", { name: "Save", exact: true }).click());
    assert.equal(agentEdit.profile.description, "Edited Chrome agent");
    assert.equal(agentEdit.profile.systemPrompt, "Read the fixture and report compatibility.");
    await footer.getByRole("button", { name: "Saved", exact: true }).waitFor();
    verified("settings.agents.edit-save", "Edited an existing sub-agent, saved and asserted preservation of its system prompt.");
    const agentFeature = settings.locator(".agents-feature-setting:visible");
    const featureName = "Enable Pi Web built-in sub-agents";
    const featureOff = await requestFromAction(page, "/api/subagents/settings", "PUT", () => agentFeature.getByRole("switch", { name: featureName, exact: true }).click());
    assert.deepEqual(featureOff, { enabled: false });
    await agentFeature.locator('[role="switch"][aria-checked="false"]').waitFor();
    const featureOn = await requestFromAction(page, "/api/subagents/settings", "PUT", () => agentFeature.getByRole("switch", { name: featureName, exact: true }).click());
    assert.deepEqual(featureOn, { enabled: true });
    await agentFeature.locator('[role="switch"][aria-checked="true"]').waitFor();
    const concurrent = agentFeature.getByRole("spinbutton", { name: "Concurrent sub-agents", exact: true });
    await concurrent.fill("6");
    const concurrencySave = await requestFromAction(page, "/api/subagents/settings", "PUT", () => concurrent.press("Tab"));
    assert.deepEqual(concurrencySave, { maxConcurrent: 6 });
    assert.deepEqual(subagentSettings, { enabled: true, maxConcurrent: 6 });
    assert.equal(await concurrent.inputValue(), "6");
    const agentsReload = await requestFromAction(page, `/api/agent/${encodeURIComponent(sessionId)}`, "POST", () => agentFeature.getByRole("button", { name: "Reload session", exact: true }).click(), 200, "reload");
    assert.deepEqual(agentsReload, { type: "reload" });
    await agentFeature.getByText("Reload the current session to apply this change.", { exact: true }).waitFor({ state: "hidden" });
    verified("settings.agents.feature-concurrency", "Toggled built-in sub-agents off/on, blur-saved concurrent prompts and pressed Reload session; asserted exact feature/concurrency/reload writes and cleared reload notice.");
    page.once("dialog", (dialog) => dialog.accept());
    const agentDelete = await requestFromAction(page, "/api/subagents/profiles", "DELETE", () => detail.getByRole("button", { name: "Delete", exact: true }).click());
    assert.deepEqual(agentDelete, { cwd: project, scope: "global", name: "chrome-agent" });
    await detail.getByText("Select or create a sub-agent profile", { exact: true }).waitFor();
    assert.equal(profiles.length, 0);
    verified("settings.agents.delete", "Accepted the profile's real browser confirmation, deleted it and asserted its scope/name/cwd plus the completed empty editor state.");

    await selectSection(settings, "plugins", "Plugins");
    await settings.getByRole("button", { name: "Add plugin", exact: true }).click();
    await detail.getByPlaceholder("npm:@scope/package", { exact: true }).fill("npm:chrome-plugin");
    const pluginInstall = await requestFromAction(page, "/api/plugins", "POST", () => detail.getByRole("button", { name: "Install", exact: true }).click());
    assert.deepEqual(pluginInstall, { action: "install", source: "npm:chrome-plugin", scope: "global", cwd: project });
    await detail.getByRole("switch", { name: "Enable package", exact: true }).waitFor();
    verified("settings.plugins.install", "Installed a fixture source through the real add form and asserted source/scope/cwd; package installation was mocked.");
    const pluginEnable = await requestFromAction(page, "/api/plugins", "POST", () => detail.getByRole("switch", { name: "Enable package", exact: true }).click());
    assert.deepEqual(pluginEnable, { action: "enable", source: "npm:chrome-plugin", scope: "global", cwd: project });
    await detail.getByRole("switch", { name: "Disable package", exact: true }).waitFor();
    verified("settings.plugins.enable", "Enabled the installed package and asserted the enable request plus the resulting Disable package control.");
    const pluginHost = settings.locator('.settings-section-host:not([hidden])');
    const pluginGroupOff = await requestFromAction(page, "/api/plugins", "POST", () => pluginHost.getByRole("switch", { name: "Disable every global package. A package with resource filters stays on, since disabling it removes them; use its own switch.", exact: true }).click());
    assert.deepEqual(pluginGroupOff, { action: "disable", cwd: project, packages: [{ source: "npm:chrome-plugin", scope: "global" }] });
    await detail.getByRole("switch", { name: "Enable package", exact: true }).waitFor();
    const pluginGroupOn = await requestFromAction(page, "/api/plugins", "POST", () => pluginHost.getByRole("switch", { name: "Enable every global package", exact: true }).click());
    assert.deepEqual(pluginGroupOn, { action: "enable", cwd: project, packages: [{ source: "npm:chrome-plugin", scope: "global" }] });
    await detail.getByRole("switch", { name: "Disable package", exact: true }).waitFor();
    verified("settings.plugins.group-switch", "Disabled and enabled the package group, asserted the bulk packages array and verified each resulting package switch.");
    const pluginCheck = await requestFromAction(page, "/api/plugins/check", "POST", () => detail.getByRole("button", { name: "Check", exact: true }).click());
    assert.deepEqual(pluginCheck, { cwd: project, source: "npm:chrome-plugin", scope: "global" });
    const pluginUpdate = await requestFromAction(page, "/api/plugins", "POST", () => detail.getByRole("button", { name: "Update", exact: true }).click());
    assert.deepEqual(pluginUpdate, { action: "update", source: "npm:chrome-plugin", scope: "global", cwd: project });
    await detail.getByText("installed 1.1.0", { exact: false }).waitFor();
    verified("settings.plugins.check-update", "Checked one package for updates, applied its offered update and asserted the saved source and displayed installed version.");
    const pluginCheckAll = await requestFromAction(page, "/api/plugins/check", "POST", () => footer.getByRole("button", { name: "Check updates", exact: true }).click());
    assert.deepEqual(pluginCheckAll, { cwd: project });
    const pluginUpdateAll = await requestFromAction(page, "/api/plugins", "POST", () => footer.getByRole("button", { name: "Update all (1)", exact: true }).click());
    assert.deepEqual(pluginUpdateAll, { action: "update", cwd: project });
    await detail.getByText("installed 1.2.0", { exact: false }).waitFor();
    await footer.getByRole("button", { name: "Check updates", exact: true }).waitFor();
    verified("settings.plugins.update-all", "Checked all installed plugins from the footer and applied Update all; asserted the unscoped update-all request and verified its installed version plus cleared update action.");
    const pluginRemove = await requestFromAction(page, "/api/plugins", "POST", () => detail.getByRole("button", { name: "Remove", exact: true }).click());
    assert.deepEqual(pluginRemove, { action: "remove", source: "npm:chrome-plugin", scope: "global", cwd: project });
    await detail.getByPlaceholder("npm:@scope/package", { exact: true }).waitFor();
    assert.equal(packages.length, 0);
    verified("settings.plugins.remove", "Removed the fixture package and observed the returned add form and empty package state.");

    await selectSection(settings, "mcp", "MCP");
    await settings.getByRole("button", { name: "Add MCP", exact: true }).click();
    const mcpText = JSON.stringify({ mcpServers: { "chrome-mcp": { url: "https://mcp.example.invalid/fixture", exposure: "direct" } } });
    await detail.getByRole("textbox", { name: "Server to add", exact: true }).fill(mcpText);
    await detail.getByText("https://mcp.example.invalid/fixture", { exact: true }).waitFor();
    const automaticTest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/mcp/test");
    const mcpAdd = await requestFromAction(page, "/api/mcp", "POST", () => detail.getByRole("button", { name: "Add", exact: true }).click());
    assert.equal(mcpAdd.action, "add");
    assert.equal(mcpAdd.text, mcpText);
    assert.equal(mcpAdd.scope, "global");
    assert.equal(mcpAdd.name, "chrome-mcp");
    assert.equal(mcpAdd.server, 0);
    assert.equal(mcpAdd.config, undefined, "The add form must send the original paste, not a trusted browser-side config");
    const automaticResponse = await automaticTest;
    assert.deepEqual(automaticResponse.request().postDataJSON(), { scope: "global", name: "chrome-mcp", cwd: project });
    await detail.getByRole("switch", { name: "Turn chrome-mcp off", exact: true }).waitFor();
    verified("settings.mcp.add-preview-test", "Pasted JSON, inspected its URL preview, added the server and asserted original paste/scope plus the automatic connection-test request.");
    const mcpDisable = await requestFromAction(page, "/api/mcp", "POST", () => detail.getByRole("switch", { name: "Turn chrome-mcp off", exact: true }).click());
    assert.deepEqual(mcpDisable, { action: "disable", scope: "global", name: "chrome-mcp", cwd: project });
    await detail.getByRole("switch", { name: "Turn chrome-mcp on", exact: true }).waitFor();
    const mcpEnable = await requestFromAction(page, "/api/mcp", "POST", () => detail.getByRole("switch", { name: "Turn chrome-mcp on", exact: true }).click());
    assert.deepEqual(mcpEnable, { action: "enable", scope: "global", name: "chrome-mcp", cwd: project });
    await detail.getByRole("switch", { name: "Turn chrome-mcp off", exact: true }).waitFor();
    verified("settings.mcp.enable-disable", "Switched the MCP server off and back on, asserted the exact scoped mutation and both resulting switch states.");
    const mcpHost = settings.locator('.settings-section-host:not([hidden])');
    const mcpGroupOff = await requestFromAction(page, "/api/mcp", "POST", () => mcpHost.getByRole("switch", { name: "Turn off every global server", exact: true }).click());
    assert.deepEqual(mcpGroupOff, { action: "set-enabled", enabled: false, servers: [{ scope: "global", name: "chrome-mcp" }], cwd: project });
    await detail.getByRole("switch", { name: "Turn chrome-mcp on", exact: true }).waitFor();
    const mcpGroupOn = await requestFromAction(page, "/api/mcp", "POST", () => mcpHost.getByRole("switch", { name: "Turn on every global server", exact: true }).click());
    assert.deepEqual(mcpGroupOn, { action: "set-enabled", enabled: true, servers: [{ scope: "global", name: "chrome-mcp" }], cwd: project });
    await detail.getByRole("switch", { name: "Turn chrome-mcp off", exact: true }).waitFor();
    verified("settings.mcp.group-switch", "Switched the global MCP group off/on and asserted the bulk server references, enabled flag and resulting controls.");
    const exposure = detail.getByRole("combobox", { name: "How chrome-mcp's tools reach the model", exact: true });
    const exposureRequest = await requestFromAction(page, "/api/mcp", "POST", () => exposure.selectOption("deferred"));
    assert.deepEqual(exposureRequest, { action: "set-exposure", scope: "global", name: "chrome-mcp", exposure: "deferred", cwd: project });
    await page.waitForFunction(() => document.querySelector('.settings-section-host:not([hidden]) .mcp-exposure-select')?.value === "deferred");
    assert.equal(await exposure.inputValue(), "deferred");
    verified("settings.mcp.tool-exposure", "Changed tool exposure through its select and asserted the exact saved exposure request and resulting value.");
    const signIn = await requestFromAction(page, "/api/mcp/sign-in", "POST", () => detail.getByRole("button", { name: "Sign in", exact: true }).click());
    assert.deepEqual(signIn, { scope: "global", name: "chrome-mcp", cwd: project });
    const redirectUrl = "http://127.0.0.1:1455/callback?code=fixture-code&state=fixture-state";
    await detail.getByRole("textbox", { name: "Address the browser landed on", exact: true }).fill(redirectUrl);
    const paste = await requestFromAction(page, "/api/mcp/sign-in/fixture-flow", "POST", () => detail.getByRole("button", { name: "Continue", exact: true }).click());
    assert.deepEqual(paste, { redirectUrl });
    await detail.getByText("Signed in. Status above shows what the server offers.", { exact: true }).waitFor();
    verified("settings.mcp.oauth-paste", "Started sign-in, pasted the callback URL, asserted redirectUrl and observed the successful sign-in outcome without opening an external login.");
    const mcpTest = await requestFromAction(page, "/api/mcp/test", "POST", () => detail.getByRole("button", { name: "Test connection", exact: true }).click());
    assert.deepEqual(mcpTest, { scope: "global", name: "chrome-mcp", cwd: project });
    await detail.getByText("fixture_lookup", { exact: true }).waitFor();
    verified("settings.mcp.connection-tools", "Explicitly tested the signed-in server and verified its returned tool in the real tools list.");
    failNextMcpTest = true;
    const failedTest = await requestFromAction(page, "/api/mcp/test", "POST", () => detail.getByRole("button", { name: "Test connection", exact: true }).click(), 503);
    assert.deepEqual(failedTest, { scope: "global", name: "chrome-mcp", cwd: project });
    await detail.getByRole("alert").filter({ hasText: "Fixture MCP temporarily unavailable" }).waitFor();
    const retriedTest = await requestFromAction(page, "/api/mcp/test", "POST", () => detail.getByRole("button", { name: "Test connection", exact: true }).click());
    assert.deepEqual(retriedTest, failedTest);
    await detail.getByRole("alert").filter({ hasText: "Fixture MCP temporarily unavailable" }).waitFor({ state: "hidden" });
    await detail.getByText("fixture_lookup", { exact: true }).waitFor();
    assert.equal(servers[0].status.state, "connected");
    verified("settings.mcp.error-retry", "Injected one failed Test response, asserted its visible diagnostic, retried through Test connection and verified the error cleared with a successful returned tool list.");
    const signOut = await requestFromAction(page, "/api/mcp", "POST", () => detail.getByRole("button", { name: "Sign out", exact: true }).click());
    assert.deepEqual(signOut, { action: "sign-out", scope: "global", name: "chrome-mcp", cwd: project });
    await detail.getByText("Signed out: the tokens stored for this server were deleted.", { exact: true }).waitFor();
    assert.equal(servers[0].signedIn, false);
    verified("settings.mcp.sign-out", "Signed out through the server's real control, asserted its scoped mutation and verified the deleted-token confirmation.");
    await requestFromAction(page, "/api/mcp/sign-in", "POST", () => detail.getByRole("button", { name: "Sign in", exact: true }).click());
    await detail.getByRole("textbox", { name: "Address the browser landed on", exact: true }).waitFor();
    const cancelSignIn = await requestFromAction(page, "/api/mcp/sign-in/fixture-flow", "DELETE", () => detail.getByRole("button", { name: "Cancel sign-in", exact: true }).click());
    assert.equal(cancelSignIn, null);
    await detail.getByText("Sign-in cancelled.", { exact: true }).waitFor();
    await detail.getByRole("textbox", { name: "Address the browser landed on", exact: true }).waitFor({ state: "hidden" });
    verified("settings.mcp.cancel-sign-in", "Started a fresh sign-in, cancelled its actual pending flow through DELETE and verified its cancellation outcome and closed paste panel.");
    const mcpRemove = await requestFromAction(page, "/api/mcp", "POST", () => detail.getByRole("button", { name: "Remove", exact: true }).click());
    assert.equal(mcpRemove.action, "remove");
    assert.equal(mcpRemove.name, "chrome-mcp");
    assert.equal(servers.length, 0);
    const undo = await requestFromAction(page, "/api/mcp", "POST", () => settings.getByRole("button", { name: "Undo", exact: true }).click());
    assert.deepEqual(undo, { action: "undo", token: "fixture-undo-token", cwd: project });
    await detail.getByRole("switch", { name: "Turn chrome-mcp off", exact: true }).waitFor();
    assert.equal(servers[0].name, "chrome-mcp");
    verified("settings.mcp.remove-undo", "Removed the server and used Undo, asserted its opaque undo token and verified the restored server controls.");
    await page.screenshot({ path: join(artifacts, `${browserMajor}-settings-functional.png`) });

    // 默认模型来自新会话选择器的星标，使用空编辑器避免改动现有会话或启动 AgentSession。
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await page.goto(`${base}/?cwd=${encodeURIComponent(project)}`);
    const modelTrigger = page.locator(".model-selector.is-toolbar > button");
    await modelTrigger.filter({ hasText: "GPT Fixture" }).waitFor();
    await modelTrigger.click();
    const modelMenu = page.getByRole("listbox");
    const secondModel = modelMenu.getByRole("option").filter({ hasText: "GPT Fixture Second" });
    await secondModel.hover();
    const defaultSave = await requestFromAction(page, "/api/models/default", "PUT", () => secondModel.locator("..").getByRole("button", { name: "Use and save as default for new chats", exact: true }).click());
    assert.deepEqual(defaultSave, { cwd: project, provider: "openai-codex", modelId: "gpt-fixture-second" });
    await modelTrigger.filter({ hasText: "GPT Fixture Second" }).waitFor();
    await modelTrigger.click();
    await modelMenu.getByRole("option").filter({ hasText: "GPT Fixture Second" }).locator("..").getByRole("img", { name: "Default model for new chats", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    verified("settings.models.default-star", "Saved a different default model from the fresh composer's real star control, asserted provider/model/cwd and verified its selected label and filled default marker without prompting an agent.");
    const reasoningTrigger = page.getByRole("button", { name: "Change reasoning level", exact: true });
    await reasoningTrigger.click();
    const highReasoning = page.getByRole("option", { name: /^high\s*High reasoning$/ });
    await highReasoning.hover();
    const reasoningSave = await requestFromAction(page, "/api/models/default", "PUT", () => highReasoning.locator("..").getByRole("button", { name: "Use and save as default reasoning level", exact: true }).click());
    assert.deepEqual(reasoningSave, { cwd: project, thinkingLevel: "high" });
    await reasoningTrigger.filter({ hasText: "high" }).waitFor();
    await reasoningTrigger.click();
    await page.getByRole("option", { name: /^high\s*High reasoning$/ }).locator("..").getByRole("img", { name: "Default reasoning level for new chats", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    verified("settings.models.default-reasoning-star", "Saved high as the default reasoning level through the real reasoning star, asserted thinkingLevel/cwd and verified the selected trigger and filled default marker.");
    return { mode: "mocked-service", coverage: evidence, uncovered: [
      "Real external model requests, OAuth token exchange and package/skill installation are intentionally replaced by controlled service fixtures",
      "System push permission/notification delivery is not requested; PowerShell process execution and web-password cookie invalidation/logout navigation remain server/platform boundaries",
      "Model catalog-price autofill and exhaustive custom compatibility-map edits are not exercised; advanced prices/headers/capabilities and default reasoning are covered",
      "Malformed project trust store, inherited trust and fresh-folder trust-and-add refusal combinations are not exercised",
      "Exhaustive service timeout/partial-bulk-failure combinations are not exercised; real cross-tab font family/weight synchronization is covered",
    ] };
  } finally {
    // 先卸载组件以关闭 EventSource 和轮询，再只移除本测试注册的 handler。
    if (!page.isClosed()) {
      // Escape 先关闭可能堆叠在 Settings 上的信任或供应商选择器，避免遮挡 Close。
      if (await settings.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
      const close = settings.getByRole("button", { name: "Close", exact: true });
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    }
    for (const stream of streams) stream.end();
    oauthServer.closeAllConnections();
    await new Promise((resolve) => oauthServer.close(resolve));
    await page.unroute(matchesFixture, fixtureHandler);
    if (!page.isClosed()) await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`);
  }
}
