"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rewriteCssValue } = require("./values.cjs");

/**
 * 在 SWC 之前统一处理组件内联样式及 styled-jsx，避免逐个修改上游组件。
 * @param {string} source Next.js 交给 loader 的原始组件源码。
 * @returns {string} 包含独立兼容变量的组件源码。
 */
module.exports = function chrome103Loader(source) {
  this.cacheable?.();
  return rewriteCssValue(source);
};
