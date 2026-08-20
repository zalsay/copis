# Copis Pi OAuth 登录实施计划

> **For agentic workers:** 按步骤执行本计划；每一步完成后运行对应验证并检查 diff。

**目标：** 将 Copis 未登录页改为使用系统浏览器完成 Pi 账号 OAuth 登录，并通过本机 Rust 回调状态进入工作空间。

**架构：** 保留现有 `CopisWorkingLoginDialog` 的页面外壳和视觉布局，登录态只渲染 Pi OAuth 主操作。渲染进程调用已有 `window.electronAPI.loginWorkingWithOAuth()`，主进程和 Rust 继续负责 discovery、授权 URL、系统浏览器跳转、回调、token 保存和 auth-state 轮询。

**技术栈：** React、TypeScript、Jotai、Electron IPC、Bun test、Vite。

## 全局约束

- renderer 不得接触 access token、refresh token、client secret 或 token endpoint。
- 不新增远程请求；所有 edu-api/Auth 请求继续由 Rust API 发出。
- 保留现有登录页品牌、布局和视觉样式。
- 所有新增注释和日志使用中文；本次不修改 `AGENTS.md` 或 `README.md`。
- 完成后必须由用户在实际 Electron 窗口确认系统浏览器授权和回调结果。

---

### Task 1: 登录页 OAuth 契约测试

**文件：**

- 修改：`apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`
- 测试：`apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx`

**接口：**

- 消费：已有 `window.electronAPI.loginWorkingWithOAuth(): Promise<WorkingAuthState>`。
- 产出：契约固定单一 Pi OAuth 登录入口、旧本地表单不再出现在登录态、成功回调使用 `onAuthenticated`。

- [ ] 添加失败断言：登录页源码必须包含 `loginWorkingWithOAuth`、`使用 Pi 账号登录`、授权中状态文案和错误处理；登录态不再包含邮箱、密码、注册、验证码和 `loginWorking` 调用。
- [ ] 运行 `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`，确认旧源码因缺少 OAuth 入口而失败。

### Task 2: 实现单一 Pi OAuth 登录交互

**文件：**

- 修改：`apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx`
- 复用：`apps/electron/src/main/lib/working-api-client.ts`、`apps/electron/src/main/ipc.ts`、`apps/electron/src/preload/index.ts`

**接口：**

- 消费：OAuth 登录 IPC 返回的 `WorkingAuthState`。
- 产出：登录页按钮状态和认证回调。

- [ ] 删除登录页本地 email/password/register/reset 状态和处理函数，只保留页面状态、OAuth busy 状态、错误提示和焦点处理。
- [ ] 添加 `handleOAuthLogin`，调用 `window.electronAPI.loginWorkingWithOAuth()`，成功时调用 `onAuthenticated`，失败时显示错误并允许重试。
- [ ] 登录主按钮显示 `使用 Pi 账号登录`；执行中显示 `正在等待 Pi 授权...`，并禁用按钮。
- [ ] 保留现有品牌、展示区、关闭按钮结构和 CSS 类，删除只服务于本地表单的 DOM。
- [ ] 运行 Task 1 契约测试，确认通过。

### Task 3: 回归验证与交付

**文件：**

- 检查：`apps/electron/src/main/lib/working-api-client.test.ts`
- 检查：`apps/electron/src/main/lib/working-oidc-client.test.ts`

- [ ] 运行 `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`。
- [ ] 运行 `bun test apps/electron/src/main/lib/working-api-client.test.ts apps/electron/src/main/lib/working-oidc-client.test.ts`。
- [ ] 运行 `bun run typecheck`。
- [ ] 运行 `bun run --filter='@copis/electron' build:renderer`。
- [ ] 检查 `git diff --check` 和目标文件 diff，确认没有 token 穿透 renderer、重复请求或无关修改。
- [ ] 启动本地 Electron 开发环境，由用户确认点击按钮后系统浏览器打开 Pi OAuth 页面，完成授权后 Copis 回调并进入工作空间。
