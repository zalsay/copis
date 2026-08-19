# Copis 原生登录界面恢复设计

## 目标

恢复 Copis Working 原有的邮箱密码登录界面，让用户继续在 Copis 内完成登录、注册和密码找回；底层请求统一通过现有 Auth 代理接口处理，保持新的认证服务、token 存储和刷新逻辑不变。

## 方案

以历史提交 `4c6c19c0` 中的 `CopisWorkingLoginDialog` 为交互基线，恢复以下状态：

- 登录：邮箱、密码、登录提交。
- 注册：邮箱、昵称、密码、邀请码、验证码和验证码倒计时。
- 找回密码：邮箱、验证码、新密码和确认密码三步流程。
- 错误、成功提示、加载状态、Escape 关闭和全屏登录页布局保持原行为。

渲染进程继续只调用 `window.electronAPI`，不读取或保存 token。主进程现有 `WorkingApiClient` 继续调用 `/api/auth/login`、`/api/auth/register`、`/api/auth/send-code`、`/api/auth/verify-code` 和 `/api/auth/password/reset`，后端由 ai-education 的 AuthProxy 转发到 Auth 模块。OIDC discovery、refresh token、JWKS 和本地凭据存储链路不做改动。

## 错误处理

表单提交前沿用原有客户端校验；服务端错误通过现有 IPC 错误消息展示。验证码发送和密码找回请求分别维护忙碌状态与 60 秒倒计时，避免重复提交。登录、注册或重置期间禁止关闭全屏登录页。

## 验证

- 更新登录页契约测试，确认默认展示原生登录表单，且包含注册、找回密码入口。
- 运行登录页契约测试、Working API/OIDC 测试。
- 运行 Electron renderer 构建和类型检查。
- 在现有开发页面中确认登录、注册/找回入口和加载状态视觉结果；真实窗口视觉验收仍由用户确认。
