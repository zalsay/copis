# Copis Pi OAuth 登录设计

## 目标

Copis 未登录页保留现有登录框的品牌、布局和视觉样式，但不再在 Copis 内收集邮箱、密码、注册验证码或找回密码信息。用户点击“使用 Pi 账号登录”后，Copis 调用已有 Rust OIDC 链路，在系统浏览器打开 Pi Auth 授权页面；授权完成后由本机回调返回 Copis，Copis 读取 Rust 保存的认证状态并进入工作空间。

## 范围

- 修改 `CopisWorkingLoginDialog` 的登录态交互与文案。
- 复用 `window.electronAPI.loginWorkingWithOAuth()`，不新增 renderer 到远端的请求。
- 保留已有的系统浏览器跳转、OIDC state/PKCE、本机回调和 Rust auth session 实现。
- 删除登录页中与本次单一 Pi 账号登录冲突的本地登录、注册和密码找回表单交互。
- 不修改 Auth 服务端协议、OAuth client、回调 URI 或 token 存储边界。

## 交互流程

1. Copis 启动读取本机 Rust 的 `auth-state`。
2. 未认证时显示现有登录页布局，主按钮文字为“使用 Pi 账号登录”。
3. 点击主按钮后调用 Electron IPC `loginWorkingWithOAuth`。
4. 主进程从 Rust 获取授权 URL，通过 `shell.openExternal` 打开系统浏览器。
5. 页面显示授权进行中状态，禁止重复点击和关闭登录流程。
6. Pi Auth 完成后回调 `127.0.0.1`，Rust 校验 state/PKCE、兑换 token 并保存安全认证状态。
7. Electron 轮询本机 auth-state；认证成功后调用 `onAuthenticated`，进入 Copis 工作空间。
8. 用户取消授权、回调失败或超时，恢复按钮可用并显示可读错误，不保存敏感信息到 renderer。

## 错误与安全边界

- renderer 只接收 `WorkingAuthState`，不接触 access token 或 refresh token。
- OAuth 授权 URL 只能由 Rust 返回，renderer 不拼接 issuer、client secret 或 token endpoint。
- 点击期间使用单一 busy 状态避免重复启动浏览器或产生并发登录请求。
- OIDC 错误沿现有 `WorkingApiError` 映射为登录页提示；取消、失败和超时都允许再次点击。

## 验证

- 登录页契约测试断言主按钮文案、OAuth IPC 调用和旧本地表单不再出现在登录态。
- Working API client OAuth 测试继续覆盖授权 URL 打开与本机 auth-state 轮询。
- 运行登录页契约测试、相关 Bun 测试、typecheck 和 Electron renderer 构建。
- 最终由用户在实际 Electron 窗口点击“使用 Pi 账号登录”，确认系统浏览器打开授权页、授权后回调并进入工作空间。
