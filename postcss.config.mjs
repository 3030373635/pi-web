import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { findCompatibilityPlugin } from "./compat/chrome-103/postcss-path.cjs";

// Turbopack 从 .next/dev/build 的 worker 加载插件，必须使用配置文件旁的绝对路径。
// 不用 new URL("./plugin", import.meta.url)：它会被当作静态资源复制，丢失插件的相对依赖。
const configDirectory = dirname(fileURLToPath(import.meta.url));
const compatibilityPlugin = findCompatibilityPlugin(configDirectory);

/** @type {import('postcss').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    [compatibilityPlugin]: {},
  },
};

export default config;
