import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { rewriteCssValue } = require("../compat/chrome-103/values.cjs");
const { CHROME_103_INIT_SCRIPT } = require("../compat/chrome-103/init.cjs");
const postcss = require("postcss");
const compatibility = require("../compat/chrome-103/postcss.cjs");
const { findCompatibilityPlugin } = require("../compat/chrome-103/postcss-path.cjs");

test("the plugin stays at its source path when Turbopack relocates config into .next", () => {
  const original = require.resolve("../compat/chrome-103/postcss.cjs");
  const root = dirname(dirname(dirname(original)));
  assert.equal(findCompatibilityPlugin(root), original);
  assert.equal(findCompatibilityPlugin(join(root, ".next")), original);
  assert.equal(findCompatibilityPlugin(join(root, ".next/dev/build/chunks")), original);
});

test("PostCSS resolves its local plugin independently of the Turbopack worker directory", async () => {
  const { default: config } = await import("../postcss.config.mjs");
  assert.ok(Object.hasOwn(config.plugins, require.resolve("../compat/chrome-103/postcss.cjs")));
});

test("viewport fallbacks cover plain values, calculations and existing keyboard variables", () => {
  assert.equal(rewriteCssValue("min(620px, calc(100dvh - 16px))"), "min(620px, calc(calc(100 * var(--pi-compat-dvh, 1dvh)) - 16px))");
  assert.equal(rewriteCssValue("var(--app-viewport-height, 100dvh)"), "var(--app-viewport-height, calc(100 * var(--pi-compat-dvh, 1dvh)))");
  assert.equal(rewriteCssValue("50vh 10px"), "50vh 10px");
});

test("mixed colors retain native CSS and carry a decodable fallback key", () => {
  const original = "color-mix(in srgb, var(--accent) 16%, transparent)";
  const result = rewriteCssValue(`0 0 0 2px ${original}`);
  const key = result.match(/--pi-compat-color-([a-f0-9]+)/)[1];
  assert.equal(Buffer.from(key, "hex").toString(), original);
  assert.ok(result.endsWith(`, ${original})`));
  assert.equal(rewriteCssValue(result), result, "Repeated processing must not nest fallbacks");
});

test("CSS transforms palettes, modules and @property defaults without changing feature queries", async () => {
  const result = await postcss([compatibility()]).process(`
    @property --tw-shadow { syntax: "*"; inherits: false; initial-value: 0 0 #0000; }
    :root { --color-red-400: oklch(70.4% 0.191 22.216); }
    @supports (height: 100dvh) { .panel { max-height: 60dvh; } }
    .card { border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
  `, { from: undefined });
  assert.match(result.css, /@supports \(height: 100dvh\)/);
  assert.match(result.css, /max-height: calc\(60 \* var\(--pi-compat-dvh, 1dvh\)\)/);
  assert.match(result.css, /--pi-compat-color-/);
  assert.doesNotMatch(result.css, /--color-red-400: oklch/);
  assert.match(result.css, /--tw-shadow: 0 0 #0000/);
});

test("missing array methods work on sparse and array-like values before app code runs", () => {
  const sandbox = { document: { documentElement: { style: { setProperty() {} } } }, CSS: { supports: () => true } };
  runInNewContext("delete Array.prototype.findLast; delete Array.prototype.findLastIndex;", sandbox);
  runInNewContext(CHROME_103_INIT_SCRIPT, sandbox);
  assert.equal(runInNewContext("[1, 3, 4].findLast(x => x % 2)", sandbox), 3);
  assert.equal(runInNewContext("[1, 3, 4].findLastIndex(x => x % 2)", sandbox), 1);
  assert.equal(runInNewContext("Array.prototype.findLast.call({0: 2, length: 1}, x => x === 2)", sandbox), 2);
  assert.equal(runInNewContext("[, ,].findLastIndex(x => x === undefined)", sandbox), 1);
  assert.equal(runInNewContext("Object.keys(Array.prototype).includes('findLast')", sandbox), false);
  assert.throws(() => runInNewContext("Array.prototype.findLast.call(null, () => true)", sandbox), /null|undefined/);
});
