# Copis Rust edu-api Gateway 设计

日期：2026-08-19

状态：已确认，进入执行计划

## 目标

把 Copis 对 ai-education/edu-api 的访问收敛到 Rust HTTP API。浏览器和 Electron
只能访问本机 Rust；Rust 统一负责 Auth 会话、edu-api 请求、refresh、并发限制、
Working 业务路由和 Pi Worker 的模型代理。

Copis 原有的邮箱密码登录、注册、验证码和找回密码界面继续保留。界面行为不变，
变化只发生在请求路径和认证归属：表单请求先到本机 Rust，再由 Rust 调用
ai-education Auth/edu-api。

## 当前事实

- apps/electron/src/main/lib/working-api-client.ts 的普通 Working 请求仍直接拼接
  远端 baseUrl。
- Rust 的 BridgeWorkingBackend 当前通过 Electron 业务桥调用
  WorkingApiClient，形成 Rust 到 Electron 再到 edu-api 的反向链路。
- native/http-api-server/src/skill_market.rs 仍保留直接访问 COPIS_BACKEND_URL 的
  路径。
- Agent RPC 目前会向 Pi Worker 注入 Working JWT 或远端模型地址。
- renderer 的 HTTP API bridge 对部分 500-504 响应存在高次数自动重试；写请求发生
  503 时会把上游故障放大成请求爆炸。
- OIDC 客户端和现有加密认证存储已经存在，但 token 所有权仍在 Electron 主进程，
  需要迁移为 Rust AuthSession 的运行时所有权。

## 总体架构

    浏览器 Renderer
          |
          | 本机 HTTP + web token
          v
    Rust HTTP API
      |  AuthSession / EduApiClient / WorkingGateway
      |  WorkingModelProxy / capability
      v
    ai-education Auth / edu-api

    Electron Renderer -> Preload -> Electron Main -> 本机 Rust HTTP API
                                                        |
                                                        +-> Auth / edu-api

    Pi Worker -> Rust 本地模型代理 -> edu-api Working Model SSE

Rust 是唯一远端网络出口。Electron 主进程只保留本地调用、UI IPC、safeStorage
适配和认证状态通知，不再实现远端 Working 请求或 refresh。

## Rust 组件边界

### EduApiClient

EduApiClient 是唯一允许创建远端 HTTP 请求的模块。它负责：

- 读取 COPIS_BACKEND_URL 和 Auth issuer 配置；
- 统一设置超时、Accept、Content-Type 和 Authorization；
- 将上游状态码、错误 code 和响应体映射为 Rust 内部错误；
- 为写请求设置单次请求语义，不做透明重试；
- 通过全局并发门限制远端请求数量；
- 为测试提供可注入的传输实现和请求计数。

其他 Rust 模块不能直接调用 ureq 或构造 edu-api URL。

### AuthSession

AuthSession 保存当前 access token、refresh token、provider、用户快照和过期时间。
token 只存在于 Rust 内存和 Electron safeStorage 适配器，不进入浏览器响应以外的
普通业务对象，不进入 Renderer、不进入 Pi 配置、不进入日志。

AuthSession 提供以下行为：

- login、register、send-code、verify-code、reset-password；
- Authorization Code + PKCE 的 OIDC 登录支持；
- refresh single-flight；
- 401 后只允许一次 refresh 再重放原请求；
- logout 和认证失败清理；
- 启动时从 Electron safeStorage 加载凭据；
- 认证状态变化通知 Electron 主进程。

### AuthOperationGate

登录、注册、发送验证码、验证验证码和密码重置属于写操作。每种操作使用
try-acquire gate：已有同类操作时立即返回 429，不等待、不重试、不继续访问上游。

refresh 使用独立 single-flight：并发请求共享同一个 refresh 结果，20 个并发
refresh 最多产生 1 个 Auth refresh 上游请求。

### WorkingGateway

WorkingGateway 把本机 API 映射为稳定的 Copis 契约，负责校验路径、方法、JSON
字段、认证状态和响应 envelope。账号、用户资料、工作区、会话、技能、反馈、
图片、订单、支付和设置相关的远端请求均通过 EduApiClient。

现有本地文件、Memory、Automation、workspace file 和其他不属于 edu-api 的 Rust
能力继续由各自模块处理。

### WorkingModelProxy

Pi Worker 不再携带 Working JWT 或远端 edu-api URL。Rust 在 Worker 启动前签发
绑定 session、模型、workspace 和过期时间的一次性 capability。Worker 只调用
本地模型代理，Rust 负责：

- 校验 capability；
- 从 AuthSession 取得 access token；
- 向 edu-api 发起模型请求；
- 顺序转发 SSE data、error 和终止事件；
- 在启动失败、停止、完成、异常和超时路径撤销 capability。

## Electron 私有桥

Rust 与 Electron 的 stdio bridge 只保留以下内部能力：

- auth-storage/load；
- auth-storage/save；
- auth-storage/clear；
- auth-state/changed。

safeStorage 的密文在 Electron 侧写入现有 working-auth.json。Rust 收到的是
AuthSession 所需的凭据，Electron 不再基于凭据发起 edu-api 请求。桥响应不能包含
业务远端响应、模型数据或未经清理的错误上下文。

公共本机 HTTP 路由不提供 token 同步接口。旧的
/internal/working-auth/token 继续返回 disabled。

## 调用规则

### 浏览器

浏览器使用本地 /api/working/*、/api/pay/* 和模型代理路由。请求必须带本机
web token；浏览器代码不得拼接 COPIS_BACKEND_URL。

### Electron

Electron Working facade 保留现有方法名和返回类型，以降低 Renderer 改动范围，
但内部只请求本机 Rust。登录 UI、注册 UI、验证码和找回密码 UI 不变。

Electron 不再读取 Working access token 来构造远端 Authorization；需要状态时调用
本机 /api/working/auth-state。

### Pi Worker

Pi Worker 配置只含本地代理地址、模型别名和一次性 capability，不含 JWT、refresh
token、远端 endpoint 或 client secret。

## 错误和重试

- 登录、注册、验证码、重置、支付、订单删除、反馈和图片生成等写请求不自动重试。
- 只允许 HTTP API 启动阶段的健康检查重试；业务请求不复用该策略。
- 本机 Rust 返回 429 时，Renderer 直接显示忙碌/稍后重试状态。
- 上游 401 触发一次 refresh single-flight；refresh 失败清理会话并返回 401。
- 上游 429、5xx 和网络错误原样映射为稳定 code，不能由 Electron 或浏览器再次
  扩大请求量。
- 日志只记录 request id、路由、状态码和耗时，不记录密码、验证码、token、
  authorization header、PKCE verifier 或请求体敏感字段。

## 兼容性

- 保留现有 Working IPC 方法名，Renderer 不需要知道 Rust 内部实现。
- 保留现有登录页面视觉和交互语义。
- 保留旧认证文件读取兼容，但新的登录和 refresh 由 Rust AuthSession 管理。
- 保留非 edu-api 的本地 Rust 能力，不把本地文件或 Memory 请求转发到远端。
- 不新增第三方依赖；优先复用现有 ureq、serde_json、base64、sha2 和 Electron
  safeStorage。

## 验证策略

验证按行为驱动开发推进：

1. 先写 Rust 并发门、refresh single-flight、远端出口边界和写请求无重试的失败
   测试。
2. 再写 AuthSession、WorkingGateway、模型代理和 Electron 本地 facade。
3. 使用 mock edu-api 验证请求次数、Authorization、错误映射和 SSE 顺序。
4. 使用 ai-education 开发 fix-test 容器做 Auth/edu-api 契约和真实 smoke。
5. 自动化验证通过后，由用户在真实 Electron 窗口确认登录、注册、找回密码、
   Agent 流式输出和支付交互；截图不能替代该确认。

## 非目标

- 本次不修改 AGENTS.md 或 README.md。
- 本次不引入本地数据库；认证持久化继续使用现有文件和 Electron safeStorage。
- 本次不把 Copis 所有本地能力改成远程服务。
- 本次不允许 Electron 或 Renderer 继续通过远端 baseUrl 旁路调用 edu-api。
