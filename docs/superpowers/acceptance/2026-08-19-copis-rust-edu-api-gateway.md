# Copis Rust edu-api Gateway 验收文档

日期：2026-08-19

文档用途：定义完成条件、测试方法和必须保留的证据。本文不描述实现步骤；
实现步骤见 docs/superpowers/plans/2026-08-19-copis-rust-edu-api-gateway.md。

## 验收结论标准

只有同时满足以下条件，Rust edu-api Gateway 才能标记为完成：

- 浏览器和 Electron 的所有 edu-api 请求都经过本机 Rust。
- Rust 是唯一构造远端 edu-api URL 和 Authorization header 的组件。
- 100 个并发登录最多产生 1 个 Auth 上游登录请求，其余请求快速收到 429。
- 20 个并发 refresh 最多产生 1 个 Auth 上游 refresh 请求。
- 登录、注册、验证码、密码重置、支付、订单删除、反馈和图片生成失败时不自动重试。
- 原有 Copis 登录、注册、找回密码 UI 和正常成功/失败状态保持可用。
- Pi Worker 配置不含 JWT、refresh token、client secret 或远端 edu-api URL。
- Working Model SSE 顺序完整、不重复、不泄漏敏感请求头。
- Auth/edu-api 使用开发 fix-test 新容器启动并通过 smoke。
- 用户在真实 Electron 应用窗口确认 UI 交互；截图、about:blank 或主渲染进程
  DOM 检查不作为 UI 验收证据。

## 调用边界验收

### A-01 远端出口唯一性

方法：

    bun test scripts/edu-api-boundary.test.ts
    rg -n "COPIS_BACKEND_URL|request_working_http|Authorization" apps/electron/src/main apps/electron/src/renderer native/http-api-server/src

通过条件：

- 远端请求构造和发送只存在于 edu_api_client 模块。
- Electron main、preload、renderer 没有直接向 edu-api 发出的 fetch/ureq。
- skill_market、payment、working model 和 Agent RPC 没有旁路远端请求。
- 所有命中的 Authorization/access_token/refresh_token 只属于 Rust AuthSession、
  safeStorage 适配、协议类型或测试断言。

失败处理：

- 任意新发现的远端出口都视为阻断问题，不能用注释或测试白名单掩盖。

### A-02 浏览器到 Rust

方法：

1. 打开本地浏览器页面。
2. 执行登录、获取当前用户、读取工作区、读取历史和模型请求。
3. 检查浏览器网络记录。

通过条件：

- 浏览器只请求 127.0.0.1 的 Rust HTTP API。
- 请求包含本机 web token，不包含 edu-api Authorization。
- Rust 返回的错误 code 能在页面显示，不出现无限处理中。

## 并发和请求爆炸验收

### A-03 登录并发门

前置条件：

- 使用 mock Auth 上游，让单个 /api/auth/login 保持 10 秒后返回。
- Rust AuthOperationGate 配置为同类操作只允许一个执行者。

方法：

    cargo test --manifest-path native/http-api-server/Cargo.toml auth_session

或者使用本机压测脚本同时发送 100 个 POST /api/working/login。

通过条件：

- mock 上游登录计数为 1。
- 1 个请求进入上游等待，其余 99 个请求快速返回 429 或等价的
  auth_operation_in_progress code。
- 等待中的请求完成后，Rust 会清理 gate。
- 下一次新的登录可以正常执行。
- 任何日志不包含密码。

### A-04 Refresh single-flight

前置条件：

- Rust 内存中有即将过期的 access token 和有效 refresh token。
- mock Auth refresh 保持可见延迟。

方法：

    cargo test --manifest-path native/http-api-server/Cargo.toml auth_session

同时触发 20 个受保护 Working 请求。

通过条件：

- mock 上游 refresh 计数为 1。
- 20 个请求共享新 access token，或在上游业务响应上表现一致。
- refresh token 轮换只保存一次最终值。
- refresh 失败时所有等待者收到统一 401，内存凭据和 safeStorage 凭据被清理。

### A-05 写请求不重试

方法：

- mock login、register、send-code、reset-password、payment、order delete、
  feedback 和 image endpoint 返回 503。
- 每个操作只执行一次。

通过条件：

- 每个 endpoint 的上游计数均为 1。
- Renderer 或 Electron 不再发起第二次同样的写请求。
- UI 显示明确失败状态，可由用户主动再次点击。
- HTTP API 启动健康检查仍可保留有限重试，但不能复用于业务请求。

## 认证和安全验收

### A-06 原生登录 UI 保持

在实际 Copis 窗口确认：

- 默认仍显示邮箱/账号和密码登录表单。
- 注册入口仍显示邮箱、昵称、密码、邀请码、验证码和验证码倒计时。
- 找回密码仍支持邮箱、验证码、新密码和确认密码流程。
- 登录、注册、验证码发送和密码重置期间的 busy、错误和成功状态可见。
- 关闭、Escape 和重新打开行为与当前 UI 约定一致。
- 界面请求只经过 Electron IPC 到本机 Rust，表单字段不被写入 localStorage。

通过条件：

- 原有 UI 不被 OAuth-only 登录页替代。
- 用户重复点击登录不会产生请求爆炸或永久 loading。

### A-07 Auth 会话所有权

方法：

1. 登录成功。
2. 重启 Electron/Rust。
3. 读取 auth-state。
4. 执行受保护请求。
5. logout。

通过条件：

- access/refresh token 只在 Rust AuthSession 和 safeStorage 适配链路中存在。
- auth-state 只返回 authenticated、用户快照和非敏感状态。
- Renderer、浏览器响应和 Pi 配置不出现 token。
- logout 后本机和 safeStorage 凭据均清理。
- 旧认证文件能按兼容规则加载，但新登录不恢复 Electron 侧远端 refresh
  定时器。

### A-08 OIDC/跨站授权边界

当 Auth 返回需要授权的响应时：

- 授权 URL 只通过主进程系统浏览器打开。
- state、PKCE verifier 和授权码只在 Rust/受信任 bridge 中使用。
- 回调只接受一次且严格校验 state。
- token 兑换和 refresh 不经过 Renderer。
- 取消、超时、错误 state 和错误 issuer 都清理临时状态。

通过条件：

- Copis 与 ai-edu 使用同一 Auth 会话。
- 访问对方 URL 时出现明确的 OAuth 授权流程，不把 token 拼入 URL。
- 不设置 client secret，不实现 implicit flow 或 password grant。

## Working 业务验收

### A-09 用户、工作区和历史

在实际窗口依次执行：

- 获取当前用户和设置快照；
- 列出并保存工作区；
- 列出会话并打开历史；
- 获取技能列表；
- 提交反馈；
- 签到和切换消息接收方式。

通过条件：

- 每个请求路径为本机 Rust。
- Rust 使用 AuthSession 的当前用户访问 edu-api。
- 响应结构与现有 Renderer 类型兼容。
- 401 只进行一次 refresh，再失败则显示登录失效。

### A-10 技能、支付、订单和图片

在测试账号和开发支付环境执行：

- 技能市场查询和安装；
- 查询钻石套餐；
- 创建、查询、取消支付；
- VIP 升级；
- 查询和删除订单；
- 图片生成。

通过条件：

- 上游调用由 EduApiClient 统一发出。
- 支付 capability 和订单状态继续绑定本地工作区与用户。
- 写请求失败不会自动重复创建订单或重复扣费。
- 支付完成后的账号状态通知不包含 token。

## Pi Worker 和流式模型验收

### A-11 Worker 配置安全

方法：

    cargo test --manifest-path native/http-api-server/Cargo.toml working_model_proxy
    cargo test --manifest-path native/http-api-server/Cargo.toml pi_rpc

检查每次 Worker 启动配置和环境变量。

通过条件：

- 不含 access token、refresh token、Authorization header、client secret。
- 不含 COPIS_BACKEND_URL 指向的远端模型地址。
- 只含本机代理地址、模型别名、session 绑定和一次性 capability。

### A-12 capability 生命周期

分别验证以下路径：

- Worker 正常启动并完成；
- Worker 启动失败；
- 用户主动停止；
- Worker 异常退出；
- SSE 超时；
- capability 过期；
- session 被删除。

通过条件：

- 每条路径最终都撤销 capability。
- 旧 capability 不能用于另一个 session、用户、workspace 或模型。
- capability 不能跨 Worker 或跨会话复用。

### A-13 SSE 顺序和错误

使用 mock edu-api 返回包含多个 data frame、空 data frame、error frame 和结束
事件的响应。

通过条件：

- Pi/Renderer 收到的 frame 顺序与上游一致。
- 不重复、不丢失、不把 SSE body 当作普通 JSON。
- Rust 不向下游转发上游 Authorization、Set-Cookie 或内部诊断 header。
- 上游 401 只走一次 Rust refresh single-flight。

## ai-education 开发容器验收

执行：

    cd /Volumes/RC500/dev/ai-education
    ./deploy/fix-test/up.sh
    ./deploy/fix-test/smoke.sh
    docker compose -f deploy/fix-test/compose.yaml ps

通过条件：

- Auth、edu-api 和依赖容器均为本次开发 fix-test 构建出的新容器。
- smoke 覆盖 login、refresh、OIDC discovery、Working 受保护请求和模型 endpoint。
- 容器日志不包含密码、token、Authorization header 或验证码。
- Auth issuer、audience、JWKS、redirect URI 和 Rust COPIS_BACKEND_URL 配置一致。
- 旧容器或 deploy smoke 进程没有继续接收测试流量。

## 自动化验证清单

执行并记录摘要：

    cargo test --manifest-path native/http-api-server/Cargo.toml
    bun test scripts/edu-api-boundary.test.ts
    bun test apps/electron/src/main/lib/working-api-client.test.ts
    bun test apps/electron/src/main/lib/http-api-server.test.ts
    bun test apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts
    bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts
    bun run typecheck
    bun run --filter='@copis/electron' build:main
    bun run --filter='@copis/electron' build:preload
    bun run --filter='@copis/electron' build:renderer

## 交付记录要求

交付时必须附带：

- Rust 并发登录和 refresh 的上游计数；
- 写请求无重试的计数结果；
- 静态边界测试结果；
- ai-education 新容器的 compose ps 和 smoke 摘要；
- Pi capability 和 SSE 测试摘要；
- Electron typecheck/build 结果；
- 用户在真实 Electron 窗口确认的功能项；
- 未通过项目、已知残余风险和后续处理边界。

## 本次执行记录

执行日期：2026-08-19

### 已通过

- Rust HTTP API 新增 edu-api/auth/gateway/model proxy 模块：`rustfmt --edition 2021 --check` 和 `git diff --check` 通过。完整 `cargo fmt --check` 受工作树中其它既有 Rust 文件的未格式化改动影响，未作为本次变更的门禁。
- Rust HTTP API：`cargo test --manifest-path native/http-api-server/Cargo.toml -- --test-threads=4`，233 项通过。
- AuthSession 并发断言：登录 gate 的上游计数为 1；20 路 refresh single-flight 的上游计数为 1；401 只重放一次；refresh 失败清理内存和存储凭据。
- 写请求边界：`EduApiClient` 对上游 503 不重试；Electron Working facade 和浏览器 bridge 的 POST 503 测试均断言只发送 1 次。
- 静态边界：`bun test scripts/edu-api-boundary.test.ts`，2 项通过；Electron/Renderer facade 不构造远端 edu-api 请求，Rust Working 业务模块不保留旧直连 helper。
- Electron facade：`bun test apps/electron/src/main/lib/working-api-client.test.ts`，5 项通过；默认只请求本机 Rust，不在 Electron 重放/刷新 token。
- HTTP bridge：`bun test apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts`，1 项通过。
- Rust HTTP server 契约：`bun test apps/electron/src/main/lib/http-api-server.test.ts`，16 项通过。
- 登录 UI 契约：`bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`，5 项通过。
- TypeScript：`PATH="$HOME/.bun/bin:$PATH" bun run typecheck`，所有 workspace 通过。
- Electron 构建：`build:main`、`build:preload`、`build:renderer` 通过。
- ai-education Go 模块：`auth`、`edu-api`、`module-gateway` 和 `working-agent-service` 的 `go test ./...` 通过。

### 未完成或受环境阻塞

- `cd /Volumes/RC500/dev/ai-education && ./deploy/fix-test/up.sh` 已执行，但在本地构建阶段超过 45 秒超时，未完成新容器启动；因此没有 `smoke.sh` 或 `docker compose ps` 的通过证据。
- ai-education `agent-orchestrator` 测试需要本机 PostgreSQL 数据库 `ai_education_agent_evolution_test`，当前连接失败；`agents-gateway` 测试缺少其自身 `go.sum` 中的 `github.com/ncruces/go-strftime` 条目。
- 真实 Electron 窗口中的登录、注册、找回密码、Working 业务和 OIDC 交互仍需用户确认；自动化测试不替代该 UI 验收。

### 关键实现边界

- Rust `edu_api_client.rs` 是唯一构造远端 edu-api URL 和 Authorization header 的生产模块。
- Rust `auth_session.rs` 持有 access/refresh token；Electron 仅通过 safeStorage stdio bridge 读写凭据，并广播不含凭据的 auth-state。
- `working_gateway.rs` 保留 `/api/users/me` 的 settings envelope，避免丢失 `has_checked_in`、`vip` 等 Renderer 所需字段。
- Working Model 使用短期、绑定 session/model 的 capability 和本机 SSE 代理；上游响应头不会透传到 Renderer。
- `@copis/electron` 已递增至 `0.0.64`，`@copis/shared` 已递增至 `0.1.70`，并同步 `bun.lock`。

## 2026-08-20 验收阻断复验

本次针对验收反馈中的三项 P1 完成修复和回归验证：

- OIDC 回调地址统一为 `http://127.0.0.1:51730/api/working/oauth/callback`。Copis Rust Gateway、ai-education `SeedClients`、初始 migration `002_oauth_provider.sql` 和升级 migration `005_copis_rust_redirect_uri.sql` 使用同一地址；旧的 `43123` 回调不会继续由 production seed 注册。
- OIDC discovery 返回的相对 `authorization_endpoint` / `token_endpoint` 会基于 issuer 拼成完整绝对 URL，同时保留 Rust 内部受控 path。系统浏览器收到的授权地址始终是 `http(s)://...`，且带路径的 issuer 也有专门回归测试。
- `/api/working/settings` 已恢复旧 Electron facade 所需的五路辅助聚合：邀请用户、家庭钱包成员、账单流水、邀请码和 receive-channel；保留 `has_checked_in`、`vip` 等 `/api/users/me` envelope 字段，并按旧客户端规则生成 `family:` / `billing:` 记录和时间排序。

本次复验命令及结果：

- `cargo test --manifest-path native/http-api-server/Cargo.toml -- --test-threads=1`：235 项通过。
- `cd /Volumes/RC500/dev/ai-education/backend/modules/auth && go test ./...`：全部通过。
- `bun test scripts/edu-api-boundary.test.ts`：2 项通过。
- `bun test apps/electron/src/main/lib/working-api-client.test.ts apps/electron/src/main/lib/working-oidc-client.test.ts`：8 项通过。
- `PATH="$HOME/.bun/bin:$PATH" bun run typecheck`：所有 workspace 通过。
- Electron `build:main`、`build:preload`、`build:renderer`：通过；renderer 仍有既有大 chunk warning。
- 本次触及 Rust 文件的 `rustfmt --edition 2021 --check` 和两仓库 `git diff --check`：通过。完整 `cargo fmt --check` 仍受工作树中其它既有 Rust 文件格式差异影响。

总体验收仍保持“暂不通过”：fix-test 新容器 smoke 尚未取得通过证据，真实 Electron 窗口中的登录/OIDC/settings 交互仍需用户确认。此前记录的 PostgreSQL、agents-gateway 依赖和 fix-test 容器环境阻塞也仍需单独处理。
