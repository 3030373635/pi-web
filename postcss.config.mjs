import { fileURLToPath } from "node:url";

// Turbopack 从 .next/dev/build 的 worker 加载插件，必须使用配置文件旁的绝对路径。
const compatibilityPlugin = fileURLToPath(new URL("./compat/chrome-103/postcss.cjs", import.meta.url));

/** @type {import('postcss').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    [compatibilityPlugin]: {},
  },
};

export default config;
