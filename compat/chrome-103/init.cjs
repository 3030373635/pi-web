"use strict";

/**
 * 在应用代码执行前安装缺失能力；现代浏览器保持原生实现。
 * 无参数：序列化到页面头部执行，只访问浏览器全局对象。
 */
function installChrome103Compatibility() {
  /**
   * 为数组添加倒序查找，支持稀疏数组及类数组对象。
   * @param {string} name 需要安装的方法名。
   * @param {boolean} returnIndex 是否返回索引。
   */
  function installFindLast(name, returnIndex) {
    if (Array.prototype[name]) return;
    Object.defineProperty(Array.prototype, name, {
      configurable: true,
      writable: true,
      value: function findLast(predicate, thisArg) {
        if (this == null) throw new TypeError("Array receiver is null or undefined");
        if (typeof predicate !== "function") throw new TypeError("predicate must be a function");
        const object = Object(this);
        const length = Math.min(Math.max(Math.trunc(Number(object.length)) || 0, 0), Number.MAX_SAFE_INTEGER);
        for (let index = length - 1; index >= 0; index--) {
          const value = object[index];
          if (predicate.call(thisArg, value, index, object)) return returnIndex ? index : value;
        }
        return returnIndex ? -1 : undefined;
      },
    });
    if (Array.prototype[Symbol.unscopables]) Array.prototype[Symbol.unscopables][name] = true;
  }
  installFindLast("findLast", false);
  installFindLast("findLastIndex", true);

  if (typeof AbortSignal !== "undefined" && !AbortSignal.timeout) {
    /**
     * 为文件终端和用量请求提供有限超时。
     * @param {number} milliseconds 超时毫秒数，必须为非负 32 位整数。
     * @returns {AbortSignal} 到期后中止的信号。
     */
    AbortSignal.timeout = function timeout(milliseconds) {
      if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 4294967295) {
        throw new RangeError("Timeout must be a non-negative 32-bit integer");
      }
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out", "TimeoutError")), milliseconds);
      return controller.signal;
    };
  }

  const root = document.documentElement;
  for (const unit of ["dvh", "svh", "lvh"]) {
    if (!CSS.supports("height", `100${unit}`)) root.style.setProperty(`--pi-compat-${unit}`, "1vh");
  }
  const missingColors = !CSS.supports("color", "color-mix(in srgb, red, blue)");
  const missingHas = !CSS.supports("selector(:has(*))");
  if (!missingColors && !missingHas) return;

  const colors = new Map();
  const resolvedColors = new Map();
  const sheetSizes = new WeakMap();
  const pending = new Set();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let frame = 0;
  let scanSheets = true;

  /**
   * 按最外层逗号拆分 CSS 函数参数。
   * @param {string} text 函数括号内的内容。
   * @returns {string[]} 保留嵌套函数的参数。
   */
  function splitArguments(text) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "(") depth++;
      if (text[index] === ")") depth--;
      if (text[index] === "," && depth === 0) {
        parts.push(text.slice(start, index).trim());
        start = index + 1;
      }
    }
    parts.push(text.slice(start).trim());
    return parts;
  }

  /**
   * 展开主题变量及变量自身的回退。
   * @param {string} value CSS 颜色表达式。
   * @param {CSSStyleDeclaration} style 根元素的当前主题值。
   * @returns {string} 已展开变量的表达式。
   */
  function resolveVariables(value, style) {
    for (let attempt = 0; attempt < 12 && value.includes("var("); attempt++) {
      value = value.replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name, fallback) => style.getPropertyValue(name).trim() || fallback || "transparent");
    }
    return value.replace(/\bcurrentColor\b/gi, style.color);
  }

  /**
   * 用浏览器原生颜色解析器读取 RGBA；对旧浏览器用 sRGB 混色近似 oklab。
   * @param {string} value 已展开变量的颜色或嵌套混色。
   * @returns {number[]} 四个 0..255 通道。
   */
  function readColor(value) {
    if (value.startsWith("color-mix(")) {
      const parts = splitArguments(value.slice(10, -1));
      const first = parts[1].match(/^(.*?)(?:\s+([\d.]+)%)?$/);
      const second = parts[2].match(/^(.*?)(?:\s+([\d.]+)%)?$/);
      let weightA = first[2] === undefined ? null : Number(first[2]) / 100;
      let weightB = second[2] === undefined ? null : Number(second[2]) / 100;
      if (weightA === null) weightA = weightB === null ? 0.5 : 1 - weightB;
      if (weightB === null) weightB = 1 - weightA;
      const total = weightA + weightB;
      if (total <= 0) return [0, 0, 0, 0];
      const a = readColor(first[1]);
      const b = readColor(second[1]);
      const alphaA = a[3] / 255 * weightA / total;
      const alphaB = b[3] / 255 * weightB / total;
      const alpha = alphaA + alphaB;
      // 使用预乘 alpha，避免与 transparent 混色时把颜色错误地变黑。
      return [0, 1, 2].map((index) => alpha ? (a[index] * alphaA + b[index] * alphaB) / alpha : 0)
        .concat(alpha * Math.min(total, 1) * 255);
    }
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "transparent";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  }

  /**
   * 从保留 var() 的 CSS 文本发现构建转换生成的混色键。
   * @param {string} text 样式规则或内联样式。
   */
  function collectColors(text) {
    if (!missingColors) return;
    for (const match of text.matchAll(/--pi-compat-color-([a-f0-9]+)/g)) {
      if (!colors.has(match[0])) {
        colors.set(match[0], match[1].replace(/../g, (part) => String.fromCharCode(parseInt(part, 16))));
      }
    }
  }

  /**
   * 读取同源样式，包括 CSS Modules、延迟加载样式及嵌套媒体规则。
   * @param {CSSRuleList} rules 当前样式表的一组规则。
   */
  function collectRules(rules) {
    for (const rule of rules) {
      if (rule.style) collectColors(rule.style.cssText);
      if (rule.cssRules) collectRules(rule.cssRules);
    }
  }

  /**
   * 扫描新增节点的内联样式；只对缺少 :has 的浏览器同步表单状态。
   * @param {Element} node 新增或样式变化的元素。
   */
  function collectNode(node) {
    collectColors(node.getAttribute("style") || "");
    for (const element of node.querySelectorAll("[style]")) collectColors(element.getAttribute("style") || "");
    if (node.matches("style, link[rel=stylesheet]") || node.querySelector("style, link[rel=stylesheet]")) scanSheets = true;
  }

  /**
   * 在一帧内合并样式发现、主题更新和表单状态同步。
   * 无参数：由 MutationObserver、change、focus 和样式加载事件调度。
   */
  function update() {
    frame = 0;
    for (const node of pending) if (node.isConnected) collectNode(node);
    pending.clear();
    if (missingColors) {
      const force = scanSheets;
      scanSheets = false;
      for (const sheet of document.styleSheets) {
        // 外部字体样式表不可跨域读取，跳过它们不会影响应用自己的 CSS。
        try {
          const rules = sheet.cssRules;
          // styled-jsx 在生产环境可能向已有表 insertRule；面板挂载时检查规则数量。
          if (force || sheetSizes.get(sheet) !== rules.length) {
            collectRules(rules);
            sheetSizes.set(sheet, rules.length);
          }
        } catch { /* 浏览器的同源限制。 */ }
      }
    }
    if (missingColors && context) {
      const style = getComputedStyle(root);
      for (const [name, expression] of colors) {
        const resolved = resolveVariables(expression, style);
        // 滚动小地图会不断更新 style；主题和表达式未变化时不能重复读取画布像素。
        if (resolvedColors.get(name) === resolved && root.style.getPropertyValue(name)) continue;
        const [red, green, blue, alpha] = readColor(resolved);
        const value = `rgba(${Math.round(red)}, ${Math.round(green)}, ${Math.round(blue)}, ${alpha / 255})`;
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
        resolvedColors.set(name, resolved);
      }
    }
    if (missingHas) {
      for (const label of document.querySelectorAll(".settings-theme-option, .settings-send-mode-option")) {
        label.toggleAttribute("data-pi-compat-checked", Boolean(label.querySelector("input:checked")));
        label.toggleAttribute("data-pi-compat-focus", Boolean(label.querySelector("input:focus-visible")));
      }
    }
  }

  /** 无参数：合并同一帧的兼容更新，避免每个流式文本事件扫描页面。 */
  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  /** 无参数：文档解析完成后观察动态弹窗、主题切换及样式加载。 */
  function start() {
    pending.add(root);
    update();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          // 忽略脚本自己写入的根颜色变量，避免观察器循环。
          if (record.target === root && record.attributeName === "style") continue;
          if (record.attributeName === "class" && record.target !== root) continue;
          pending.add(record.target);
        } else {
          if (record.target.parentElement?.tagName === "STYLE" || record.target.nodeName === "STYLE") scanSheets = true;
          for (const node of record.addedNodes) if (node.nodeType === 1) pending.add(node);
        }
      }
      if (pending.size || scanSheets) schedule();
    }).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "data-theme", "checked"] });
    for (const event of ["change", "input", "focusin", "focusout"]) document.addEventListener(event, schedule);
    window.addEventListener("storage", schedule);
    document.addEventListener("load", (event) => {
      if (event.target.tagName === "LINK") { scanSheets = true; schedule(); }
    }, true);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

const CHROME_103_INIT_SCRIPT = `"use strict";(${installChrome103Compatibility.toString()})();`;
module.exports = { CHROME_103_INIT_SCRIPT };
