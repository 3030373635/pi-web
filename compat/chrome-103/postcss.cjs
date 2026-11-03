"use strict";

/* eslint-disable @typescript-eslint/no-require-imports */
const { transform } = require("lightningcss");
const { rewriteCssValue } = require("./values.cjs");

/**
 * 将静态现代颜色转为 Chrome 103 能识别的颜色，包含 Tailwind 主题变量。
 * @param {string} value CSS 声明的原始值。
 * @returns {string} 静态颜色转换后的值；动态混色留给独立运行时。
 */
function lowerStaticColors(value) {
  return value.replace(/\b(?:oklch|oklab|lab|lch|hwb)\([^()]+\)/g, (color) => {
    const { code } = transform({
      filename: "chrome-103-color.css",
      code: Buffer.from(`a{color:${color}}`),
      targets: { chrome: 103 << 16 },
      minify: true,
    });
    return code.toString().match(/color:([^;}]+)/)?.[1] ?? color;
  });
}

/**
 * 在 Tailwind 生成 CSS 后补齐旧浏览器缺失的颜色、视口及 @property 默认值。
 * @returns {import('postcss').Plugin} Next.js PostCSS 插件。
 */
module.exports = function chrome103Postcss() {
  return {
    postcssPlugin: "pi-web-chrome-103",
    OnceExit(root, { postcss }) {
      const defaults = postcss.rule({ selector: "*, ::before, ::after, ::backdrop" });
      root.walkAtRules("property", (rule) => {
        const initial = rule.nodes?.find((node) => node.type === "decl" && node.prop === "initial-value");
        if (initial) defaults.append({ prop: rule.params, value: initial.value });
      });
      if (defaults.nodes.length) {
        // 兼容分支显式初始化，仍保留原生 @property；放在 base 层，不能覆盖 utilities。
        const fallback = postcss.atRule({ name: "supports", params: "not (color: color-mix(in srgb, red, blue))" });
        fallback.append(defaults);
        const layer = postcss.atRule({ name: "layer", params: "base" });
        layer.append(fallback);
        root.append(layer);
      }
      root.walkDecls((declaration) => {
        declaration.value = rewriteCssValue(lowerStaticColors(declaration.value));
      });
    },
  };
};
module.exports.postcss = true;
