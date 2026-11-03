# Full-site Chrome 103 Implementation Plan

> **For agentic workers:** Use independent domain agents and consolidate through Windows Actions.

**Goal:** 补齐全站已识别页面和主要交互的 Chrome 103 兼容与明确覆盖证据。

**Architecture:** 沿用兼容层，将设置、内容、平台、导航验收拆分为独立模块；Windows 矩阵共享生产构建。原生页面与控件真实执行，需要外部服务的流程使用明确标记的模拟接口。

**Spec:** docs/superpowers/specs/2026-11-03-chrome-103-fullsite-design.md

## Global Constraints

- 只在 Windows Actions 执行测试；用户已允许临时分支提交推送，不合并主分支。
- 不读取真实凭据、不调用真实模型、不安装外部插件；隔离配置和文件目录。
- 不以“内容非空”“加载中”“错误信息”替代功能成功断言。
- 新增函数有中文注释和参数解释；兼容代码保持集中。

## Review Focus

- 各套模拟请求是否匹配真实接口、确实断言了提交与显示结果。
- 延迟模块、图表链接、终端渲染及复杂文件是否触发新 API/语法缺口。
- 短窗口中按钮与滚动区域是否实际可达，新增弹窗是否正确回收。
- 各模块不会遗留 route、SSE、进程、cookie 或共享夹具污染后续用例。
- 报告区分真实本地集成、模拟服务和外部/原生平台边界。

## Tasks

- [x] 设置域：General 与各配置页的主要编辑/提交/测试/登录 UI。
- [x] 内容域：富文本、图表、主要文件预览及聊天选择器。
- [x] 平台域：登录、终端、子代理、扩展与系统面板。
- [x] 导航域：会话/项目/工作树与跨标签页真实本地集成。
- [x] 兼容层：根据源码和失败用例修复能力缺口，先补 URL.canParse。
- [x] CI：共享构建、独立套件矩阵、完整覆盖报告及截图/trace。
- [ ] Windows 103/当前 Chromium 的生产与 Turbopack 回归通过；审阅结果并明确外部边界。
