# Browser Agent 当前页面控制设计

## 目标

Copis 网页工具栏打开的右侧抽屉应像 ChatGPT Chrome Extension 的侧栏一样，允许用户通过自然语言询问当前页面，并在明确授权后控制当前 Copis 内部 `WebContentsView` 页面。

## 交互设计

- 抽屉 Header 使用 `询问 | 授权` 分段控制。
- `询问`模式允许读取当前页面结构、可见文本和页面状态，但禁止点击、输入、滚动、按键和导航。
- `授权`模式允许执行普通页面操作。
- 页面 Origin 变化后授权立即失效并回到`询问`，避免授权跨站继承。
- 密码、验证码、支付、文件上传和其他敏感输入不允许由 Agent 填写。
- 提交、删除、购买、发送等具有外部影响的动作即使在`授权`模式下也必须单次确认。
- Browser 抽屉隐藏通用 Agent 权限模式按钮，避免与网页授权语义混淆。

## 架构

- `@copis/shared` 定义 Browser 控制模式、高层观察结果、操作参数和 IPC 通道，不暴露 CDP method 或任意脚本。
- Electron 主进程维护 session + Origin 授权状态，并提供受限的页面观察与交互服务。
- Pi Agent 只获得 `BrowserPageObserve`、`BrowserPageClick`、`BrowserPageType`、`BrowserPageSelect`、`BrowserPagePress`、`BrowserPageScroll` 和 `BrowserPageNavigate` 等高层工具。
- Renderer 通过高层 IPC 切换`询问/授权`，不接收 CDP，也不能自行执行页面动作。
- 页面内容始终标记为 untrusted browser data，不能作为系统指令执行。

## 验证

- 单元测试覆盖默认询问、同 Origin 授权、跨 Origin 自动撤销、只读/写操作门禁和敏感动作判断。
- 组件逻辑测试覆盖 Header 两种模式和 Browser 输入工具栏隐藏通用权限按钮。
- Electron Browser Workflow E2E 覆盖真实内部页面的观察、授权后点击/输入及跨 Origin 撤权。
- 运行 shared、main、preload、renderer 构建与 `git diff --check`。
