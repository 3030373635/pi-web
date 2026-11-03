# Chrome 103 内网兼容

目标：不升级内网 Chrome 103，恢复长对话滚动、输入框、侧栏、文件视图、设置及辅助弹窗的日常使用。仅在 Windows Actions 验证，不在开发目录运行生产构建，不自动提交 Git。

方案：独立 `compat/chrome-103/` 目录，页面入口加载能力检测及 API 回退；统一的构建转换处理 CSS、CSS Modules 和组件内的 CSS 字符串。上游业务组件不逐个打补丁。相比散布修改，接入点集中；相比对 `.next` 搜索替换，不依赖压缩产物的结构。

- 视口单位保留现代单位作为默认，只在浏览器缺少能力时回退到 `vh`。
- 颜色混合保留原生实现，旧浏览器用主题变量计算 sRGB 回退；静态现代颜色在构建时转换。
- 不支持 `:has()` 的表单选中和键盘焦点通过独立属性同步；不支持容器查询的 Debug 面板使用可收缩单列。
- 在应用模块执行前补充缺失的 `findLast`、`findLastIndex` 和 `AbortSignal.timeout`。
- Windows CI 使用真实 Chromium 103（核对实际版本），以及当前 Chromium 做回归，保留日志、截图和 trace。GitHub 托管 Windows Server 2022 不等同于 Windows 10 1909，最终仍需内网目标机验收。
- 不承诺未来上游新增特性自动兼容；CI 用真实浏览器在升级后发现问题。

用户已选择全部日常界面范围及 Windows Actions 验证。提交信息只输出中文建议。
