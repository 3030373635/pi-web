import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * 将兼容转换接入 Next 的两个构建器，保留上游已有的规则。
 * @param config 上游 Next.js 配置。
 * @param root 仓库绝对路径，用于定位本地 loader 和组件。
 * @returns 已加入 Chrome 103 转换的 Next.js 配置。
 */
export function withChrome103Compatibility(config: NextConfig, root: string): NextConfig {
  const loader = join(root, "compat/chrome-103/loader.cjs");
  const webpack = config.webpack;
  return {
    ...config,
    turbopack: {
      ...config.turbopack,
      rules: {
        ...config.turbopack?.rules,
        "*.tsx": { loaders: [loader] },
      },
    },
    webpack(configuration, context) {
      const result = webpack ? webpack(configuration, context) : configuration;
      result.module.rules.push({
        test: /\.tsx$/,
        include: [join(root, "app"), join(root, "components")],
        enforce: "pre",
        loader,
      });
      return result;
    },
  };
}
