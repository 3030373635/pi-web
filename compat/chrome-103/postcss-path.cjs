"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

/**
 * 定位项目内的 PostCSS 插件，兼容 Turbopack 将配置定位到 .next 子目录的情况。
 * @param {string} startDirectory 配置文件或构建 worker 报告的绝对目录。
 * @returns {string} 原始插件绝对路径，保留它与 values.cjs 的目录关系。
 */
function findCompatibilityPlugin(startDirectory) {
  let directory = resolve(startDirectory);
  while (true) {
    const plugin = join(directory, "compat/chrome-103/postcss.cjs");
    if (existsSync(plugin)) return plugin;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate Pi Web Chrome 103 PostCSS plugin from ${startDirectory}`);
    directory = parent;
  }
}

module.exports = { findCompatibilityPlugin };
