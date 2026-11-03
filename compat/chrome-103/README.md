# Chrome 103 内网兼容层

所有兼容实现保存在此目录。上游接入点是 `app/layout.tsx`、`next.config.ts` 和 `postcss.config.mjs`，业务组件不逐个修改。

## 工作方式

- `values.cjs`：统一包装动态视口单位及混色函数，原生 CSS 保留为默认值。包装使用可还原的表达式键，避免维护一份容易遗漏的颜色清单。
- `loader.cjs` / `next-config.ts`：在 webpack 和 Turbopack 编译组件前处理内联样式和 styled-jsx。
- `postcss.cjs`：在 Tailwind 之后处理全局 CSS、CSS Modules 和静态现代颜色；兼容分支在 base 层显式初始化属性默认值，仍保留原生 `@property`。
- `init.cjs`：在应用代码前补充缺失 API。旧浏览器使用 `vh`；混色按当前主题计算预乘 alpha 的 sRGB 颜色，主题切换、动态内联样式和后加载的样式表会更新。原生 oklab 混色在旧浏览器近似为 sRGB；`currentColor` 混色采用根文本颜色，属于视觉回退，并非完整 CSS Color 规范 polyfill。
- `fallbacks.css`：设置表单的选中/焦点状态及 Debug 容器查询回退。

## 跟随上游更新

1. 合并上游时保留三个接入点及本目录。上游若新增相同 glob 的 Turbopack 规则，需合并 loader 列表，不能互相覆盖。
2. 保留 npm `files` 和离线打包脚本中的 `compat`，否则生产启动无法加载 Next 配置。`lightningcss` 是构建依赖。
3. 运行 **Chrome 103 Windows compatibility** Actions。测试使用固定官方 Chromium 快照 1002885（103.0.5060.0），核对下载校验和和浏览器实际版本，同时验证当前 Chromium。
4. 下载 `chrome-103-windows-results` 查看截图、trace、服务日志及实际浏览器版本。测试不调用模型，也不修改真实用户配置。
5. 最后将离线包放到 Windows 10 1909 / Chrome 103.0.5060.134 验收。GitHub 托管 runner 为 Windows Server 2022，不能代替那台具体电脑。

## 测试范围

Windows workflow 执行 lint、typecheck、兼容转换/API 和 Windows 打包回归，再构建生产应用。生产 webpack 与开发 Turbopack 分别运行真实 103 和当前浏览器，验证原问题的失败/恢复、长对话滚轮、输入框可见、窗口缩放、侧栏布局切换、文件查看、设置六个页面、主题与键盘选中、短窗口设置滚动、草稿保留和刷新，以及动态样式表/随面板挂载插入的 CSSOM 规则。截图用于补充视觉检查。

未来上游若增加新的浏览器 API、CSS 功能或三方依赖，这一层不会自动保证其兼容，需由同一工作流发现并补充回退。
