"use strict";

/**
 * 找到 CSS 函数的结束括号，保留嵌套 var()/calc()。
 * @param {string} value 原始 CSS 值或组件源码。
 * @param {number} start 函数左括号的位置。
 * @returns {number} 配对右括号的位置，未闭合时返回 -1。
 */
function closingParenthesis(value, start) {
  let depth = 0;
  for (let index = start; index < value.length; index++) {
    if (value[index] === "(") depth++;
    if (value[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

/**
 * 将现代 CSS 值包装为能力检测脚本可提供的回退，保留原生值。
 * @param {string} value 声明值或包含 CSS 字符串的组件源码。
 * @returns {string} 可重复处理的兼容值。
 */
function rewriteCssValue(value) {
  let result = "";
  let cursor = 0;
  const token = /var\(--pi-compat-(?:color-[a-f0-9]+|[dsl]vh)\s*,|color-mix\(|-?\d*\.?\d+[dsl]vh\b/g;
  let match;
  while ((match = token.exec(value))) {
    result += value.slice(cursor, match.index);
    if (match[0].startsWith("var(")) {
      // 不再次转换已经包装的回退，否则 loader 与 PostCSS 会重复嵌套。
      const end = closingParenthesis(value, match.index + 3);
      if (end < 0) break;
      result += value.slice(match.index, end + 1);
      cursor = token.lastIndex = end + 1;
    } else if (match[0] === "color-mix(") {
      const end = closingParenthesis(value, token.lastIndex - 1);
      if (end < 0) break;
      const expression = value.slice(match.index, end + 1);
      const key = Buffer.from(expression).toString("hex");
      result += `var(--pi-compat-color-${key}, ${expression})`;
      cursor = token.lastIndex = end + 1;
    } else {
      const [, amount, unit] = match[0].match(/^(-?\d*\.?\d+)([dsl]vh)$/);
      result += `calc(${amount} * var(--pi-compat-${unit}, 1${unit}))`;
      cursor = token.lastIndex;
    }
  }
  return result + value.slice(cursor);
}

module.exports = { rewriteCssValue };
