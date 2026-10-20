#!/usr/bin/env node

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const APP_PATHS = [".next", "bin", "node_modules", "public", "package.json", "next.config.ts"];

/**
 * 解析 Windows 离线包脚本的命名参数。
 * @param {string[]} argumentsList 进程收到的命令行参数，不包含 node 和脚本路径。
 * @returns {{ packageRoot: string, runtimeRoot: string, outputRoot: string }} 三个绝对目录。
 */
function parseArguments(argumentsList) {
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("用法: package-offline-windows-x64.mjs --package-root <目录> --runtime-root <目录> --output-root <目录>");
    }
    values.set(key, value);
  }

  const packageRoot = values.get("--package-root");
  const runtimeRoot = values.get("--runtime-root");
  const outputRoot = values.get("--output-root");
  if (!packageRoot || !runtimeRoot || !outputRoot || values.size !== 3) {
    throw new Error("必须且只能提供 --package-root、--runtime-root 和 --output-root");
  }

  return {
    packageRoot: path.resolve(packageRoot),
    runtimeRoot: path.resolve(runtimeRoot),
    outputRoot: path.resolve(outputRoot),
  };
}

/**
 * 确认打包所需路径存在，并在缺失时给出包含用途的错误。
 * @param {string} requiredPath 需要检查的绝对路径。
 * @param {string} description 路径在离线包中的用途说明。
 */
async function requirePath(requiredPath, description) {
  try {
    await stat(requiredPath);
  } catch {
    throw new Error(`缺少${description}: ${requiredPath}`);
  }
}

/**
 * 复制生产构建目录，同时丢弃目标机器不需要的 Next.js 增量缓存。
 * @param {string} sourceRoot 源项目中的 .next 目录。
 * @param {string} targetRoot 离线包应用目录中的 .next 目录。
 */
async function copyNextBuild(sourceRoot, targetRoot) {
  const cacheRoot = path.join(sourceRoot, "cache");
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (sourcePath) => sourcePath !== cacheRoot && !sourcePath.startsWith(`${cacheRoot}${path.sep}`),
  });
}

/**
 * 生成可从任意解压目录启动 Pi Web 的 Windows 批处理入口。
 * @param {string} bundleRoot Windows 离线包根目录。
 */
async function writeLaunchers(bundleRoot) {
  const startScript = [
    "@echo off",
    "setlocal",
    "rem 始终从离线包根目录启动，解压路径改变后相对文件仍然有效。",
    'set "BUNDLE_ROOT=%~dp0"',
    'cd /d "%BUNDLE_ROOT%"',
    'set "PATH=%BUNDLE_ROOT%runtime;%BUNDLE_ROOT%app\\node_modules\\.bin;%PATH%"',
    'set "PLAYWRIGHT_BROWSERS_PATH=%BUNDLE_ROOT%browsers"',
    'set "NO_UPDATE_NOTIFIER=1"',
    '"%BUNDLE_ROOT%runtime\\node.exe" "%BUNDLE_ROOT%app\\bin\\pi-web.js" --no-open %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");

  const playwrightScript = [
    "@echo off",
    "setlocal",
    "rem 包装器固定使用离线包内的浏览器，不访问用户机器上的 Playwright 缓存。",
    'for %%I in ("%~dp0..") do set "BUNDLE_ROOT=%%~fI"',
    'set "PLAYWRIGHT_BROWSERS_PATH=%BUNDLE_ROOT%\\browsers"',
    "rem Playwright CLI 默认选择系统 Chrome；仅在用户未指定时改用包内 Chromium。",
    'if not defined PLAYWRIGHT_MCP_BROWSER set "PLAYWRIGHT_MCP_BROWSER=chromium"',
    'call "%BUNDLE_ROOT%\\app\\node_modules\\.bin\\playwright-cli.cmd" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");

  await writeFile(path.join(bundleRoot, "start.cmd"), startScript);
  await writeFile(path.join(bundleRoot, "runtime", "playwright-cli.cmd"), playwrightScript);
}

/**
 * 组装 Windows 10 x64 离线目录，压缩和校验由 GitHub Actions 负责。
 * @param {{ packageRoot: string, runtimeRoot: string, outputRoot: string }} options 打包输入与输出目录。
 * @returns {Promise<string>} 生成的离线包根目录。
 */
async function stageWindowsPackage({ packageRoot, runtimeRoot, outputRoot }) {
  for (const relativePath of [...APP_PATHS, ".playwright-browsers", "LICENSE"]) {
    await requirePath(path.join(packageRoot, relativePath), "打包文件");
  }
  await requirePath(path.join(runtimeRoot, "node.exe"), "Windows x64 Node.js 运行时");

  const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json 缺少有效的 version");
  }

  const bundleName = `pi-web-${packageJson.version}-windows-x64`;
  const bundleRoot = path.join(outputRoot, bundleName);
  const appRoot = path.join(bundleRoot, "app");
  await rm(bundleRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });

  for (const relativePath of APP_PATHS) {
    const sourcePath = path.join(packageRoot, relativePath);
    const targetPath = path.join(appRoot, relativePath);
    if (relativePath === ".next") {
      await copyNextBuild(sourcePath, targetPath);
    } else {
      await cp(sourcePath, targetPath, { recursive: true });
    }
  }

  // Chromium 和 Node.js 都随包分发，目标 Windows 10 机器首次启动不依赖网络。
  await cp(path.join(packageRoot, ".playwright-browsers"), path.join(bundleRoot, "browsers"), { recursive: true });
  await cp(runtimeRoot, path.join(bundleRoot, "runtime"), { recursive: true });
  await cp(path.join(packageRoot, "LICENSE"), path.join(bundleRoot, "LICENSE"));
  await writeLaunchers(bundleRoot);
  return bundleRoot;
}

const options = parseArguments(process.argv.slice(2));
const bundleRoot = await stageWindowsPackage(options);
process.stdout.write(`${bundleRoot}\n`);
