# Copis Rust edu-api Gateway Implementation Plan

> For agentic workers: use subagent-driven development or executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** 将 Copis 所有指向 ai-education/edu-api 的请求收敛到 Rust HTTP API，同时保留原有 Copis 登录、注册、验证码、找回密码 UI。

**Architecture:** Rust HTTP API 新增 EduApiClient、AuthSession、AuthOperationGate、WorkingGateway 和 WorkingModelProxy。Electron 主进程与浏览器只访问本机 Rust；Electron 的 stdio bridge 只提供 safeStorage 读写和认证状态通知；Pi Worker 只拿一次性本地 capability，不拿 JWT 或远端 URL。

**Tech Stack:** Rust 2021、ureq、serde/serde_json、Mutex/Condvar、Electron main/preload、React 18、Jotai、Bun test、ai-education Go/Gin、Docker Compose fix-test。

## Global Constraints

- 远端 edu-api 请求只能出现在 native/http-api-server/src/edu_api_client.rs。
- 登录、注册、验证码、密码重置、支付、反馈、图片生成等写请求不自动重试。
- AuthOperationGate 同类写操作已有执行时立即返回 429；refresh 使用 single-flight。
- Renderer、浏览器普通脚本和 Pi Worker 不得读取或持有 access token、refresh token、密码、验证码或 PKCE verifier。
- Electron 业务 facade 只请求本机 Rust，不拼接 COPIS_BACKEND_URL。
- Rust stdio bridge 只允许 auth-storage/load、auth-storage/save、auth-storage/clear 和 auth-state/changed。
- 复用现有依赖，不新增第三方依赖；若检查发现必须新增依赖，先停止并报告版本与许可证评估结果。
- 注释和日志优先中文；日志不得包含 token、密码、验证码、Authorization header、请求体敏感字段。
- 每个行为先写失败测试，运行到预期失败后再写生产代码。
- 保留当前工作树中与本任务无关的用户修改，不执行 reset、checkout、清理或全量暂存。
- 不修改 AGENTS.md 或 README.md。
- Electron UI 最终必须由用户在真实应用窗口确认，自动化测试和截图不能代替该确认。

---

### Task 1: 固化本地边界并关闭业务请求重试

**Files:**

- Create: apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts
- Modify: apps/electron/src/renderer/lib/http-api-bridge.ts
- Create: scripts/edu-api-boundary.test.ts
- Modify: scripts/functional-module-boundary.test.ts

**Interfaces:**

- Produces: browser bridge 只对启动健康检查重试；业务 POST/PUT/PATCH/DELETE 不重试。
- Produces: 静态边界测试能枚举 Electron、Renderer、Rust 的 edu-api 出口。

- [ ] **Step 1: Write the failing tests**

  在 http-api-bridge.contract.test.ts 注入返回 503 的 fetch，调用一个 POST
  业务请求，断言调用次数为 1；调用 HTTP API 启动健康检查时保留既有短重试。
  在 edu-api-boundary.test.ts 扫描 Electron main、renderer 和 Rust 源码，断言
  Electron/renderer 不得出现 COPIS_BACKEND_URL 的远端 fetch，Rust 只有
  edu_api_client 模块可以构造远端 URL。

- [ ] **Step 2: Run tests to verify RED**

  Run:

      bun test apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts
      bun test scripts/edu-api-boundary.test.ts

  Expected: 业务 503 测试因现有重试次数大于 1 失败；边界测试因现有
  WorkingApiClient、skill_market 和 Pi 配置仍存在远端旁路失败。

- [ ] **Step 3: Implement the smallest boundary change**

  将请求函数拆成 startupHealthFetch 和 businessFetch。businessFetch 只执行一次，
  保留响应解析和错误 code；启动健康检查只在连接未建立时按现有次数重试。静态
  扫描先登记允许的 Rust 出口文件和明确的本地能力白名单，避免把 Memory、
  Automation、文件 API 误判为 edu-api 旁路。

- [ ] **Step 4: Run focused tests**

  Run the two commands from Step 2 and expect PASS.

- [ ] **Step 5: Commit only intended files**

      git add apps/electron/src/renderer/lib/http-api-bridge.ts apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts scripts/edu-api-boundary.test.ts scripts/functional-module-boundary.test.ts
      git commit -m "fix(auth): stop business request retry amplification"

---

### Task 2: 建立 Rust EduApiClient 和上游并发门

**Files:**

- Create: native/http-api-server/src/edu_api_client.rs
- Create: native/http-api-server/src/edu_api_client_tests.rs
- Modify: native/http-api-server/src/main.rs
- Modify: native/http-api-server/Cargo.toml only if an existing dependency cannot provide the required behavior

**Interfaces:**

    pub struct EduApiRequest {
        pub method: String,
        pub path: String,
        pub body: Option<String>,
        pub access_token: Option<String>,
        pub request_id: String,
    }

    pub struct EduApiResponse {
        pub status: u16,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    pub trait EduApiTransport: Send + Sync {
        fn send(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError>;
    }

    pub struct EduApiClient {
        pub fn request(&self, request: EduApiRequest) -> Result<EduApiResponse, EduApiError>;
    }

- Consumes: COPIS_BACKEND_URL、现有 ureq 和 serde_json。
- Produces: 所有后续 Rust 模块唯一使用的远端请求接口；401、429、5xx、超时和
  非 JSON 响应都有稳定错误映射。

- [ ] **Step 1: Write the failing tests**

  在 edu_api_client_tests.rs 写以下行为：

  - 请求 URL 只能由配置的远端 base URL 和受控 path 组合；
  - 带 access token 时设置单个 Authorization header，日志快照不含 token；
  - POST 上游返回 503 时 transport 只收到一次调用；
  - 并发请求超过配置上限时立即返回本地 overloaded 错误；
  - 上游响应 body、status 和 code 能保留给 WorkingGateway；
  - 不允许绝对 URL、header 注入和不在允许字符集中的 path。

- [ ] **Step 2: Run the Rust tests to verify RED**

  Run:

      cargo test --manifest-path native/http-api-server/Cargo.toml edu_api_client

  Expected: FAIL，因为 edu_api_client.rs 和测试所需的接口尚不存在。

- [ ] **Step 3: Implement the client**

  使用现有 ureq 实现同步 transport，将请求前的全局并发计数放入
  EduApiClient。请求体和响应体使用显式大小限制；写请求不进行重试；错误只保留
  status、公开 code、request id 和截断后的非敏感消息。用依赖注入的
  EduApiTransport 让测试可以准确统计上游调用次数。

- [ ] **Step 4: Run the focused tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml edu_api_client

  Expected: PASS，且没有 token 或密码输出。

- [ ] **Step 5: Commit**

      git add native/http-api-server/src/edu_api_client.rs native/http-api-server/src/edu_api_client_tests.rs native/http-api-server/src/main.rs native/http-api-server/Cargo.toml
      git commit -m "feat(rust): add typed edu-api client"

---

### Task 3: 迁移 Rust AuthSession、safeStorage bridge 和并发锁

**Files:**

- Create: native/http-api-server/src/auth_session.rs
- Create: native/http-api-server/src/auth_session_tests.rs
- Modify: native/http-api-server/src/main.rs
- Modify: apps/electron/src/main/lib/http-api-handler.ts
- Modify: apps/electron/src/main/lib/working-auth-store.ts
- Modify: apps/electron/src/main/lib/working-auth-store.test.ts
- Modify: apps/electron/src/main/lib/http-api-server.ts

**Interfaces:**

    pub trait AuthStorage: Send + Sync {
        fn load(&self) -> Result<Option<PersistedAuth>, AuthError>;
        fn save(&self, auth: &PersistedAuth) -> Result<(), AuthError>;
        fn clear(&self) -> Result<(), AuthError>;
    }

    pub struct AuthSession {
        pub fn auth_state(&self) -> WorkingAuthState;
        pub fn login(&self, input: LoginInput) -> Result<WorkingAuthState, AuthError>;
        pub fn register(&self, input: RegisterInput) -> Result<RegisterResult, AuthError>;
        pub fn send_code(&self, input: SendCodeInput) -> Result<(), AuthError>;
        pub fn verify_reset_code(&self, input: VerifyResetCodeInput) -> Result<ResetToken, AuthError>;
        pub fn reset_password(&self, input: ResetPasswordInput) -> Result<(), AuthError>;
        pub fn refresh_single_flight(&self) -> Result<String, AuthError>;
        pub fn logout(&self) -> Result<(), AuthError>;
    }

- Consumes: EduApiClient、AuthStorage、现有 working-auth.json 兼容格式。
- Produces: Rust 所有权的 access/refresh token、同类写操作 429、refresh single-flight
  和不包含凭据的认证状态。

- [ ] **Step 1: Write the failing tests**

  在 auth_session_tests.rs 覆盖：

  - 100 个并发 login 只有 1 个上游 login，其他请求在本机快速收到 429；
  - 20 个并发 refresh 只有 1 个上游 refresh，所有调用拿到同一个新 token；
  - 登录成功保存 token，auth_state 只返回 authenticated、user 和过期时间；
  - 登录失败、refresh 401、logout 都清理 Rust 内存和 safeStorage；
  - register、send-code、verify-code、reset-password 使用对应上游 path；
  - 输入字段会被限制长度，日志和错误响应不包含密码、验证码和 token。

  在 http-api-handler 的 bridge 测试中断言 load/save/clear 只能调用
  safeStorage 适配，不允许调用 WorkingApiClient 远端方法。

- [ ] **Step 2: Run tests to verify RED**

      cargo test --manifest-path native/http-api-server/Cargo.toml auth_session
      bun test apps/electron/src/main/lib/working-auth-store.test.ts

  Expected: Rust 测试因 AuthSession 不存在失败；Electron 测试继续暴露旧 token
  store 与远端 WorkingClient 的耦合。

- [ ] **Step 3: Implement AuthSession and the private bridge**

  在 Rust 中实现 per-operation try-lock 和 Condvar single-flight。AuthSession
  通过 EduApiClient 调用现有 ai-education Auth proxy；如果登录响应包含 OIDC
  授权需求，保存一次性 state/PKCE 状态并返回不含凭据的 authorization URL，
  token 兑换和 refresh 仍在 Rust 完成。

  在 Electron handler 中增加仅由 stdio bridge 调用的 auth-storage/load、
  auth-storage/save、auth-storage/clear。save 只接收 Rust 的结构化认证记录，
  使用现有 safeStorage 加密；load 只返回 Rust 所需字段；任何公共 HTTP 路由都
  不暴露这些操作。删除 Rust 到 Electron 的业务 Working 请求入口依赖。

- [ ] **Step 4: Run the focused tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml auth_session
      bun test apps/electron/src/main/lib/working-auth-store.test.ts

  Expected: PASS，100 个登录请求只有 1 个上游请求，20 个 refresh 只有 1 个
  上游请求。

- [ ] **Step 5: Commit**

      git add native/http-api-server/src/auth_session.rs native/http-api-server/src/auth_session_tests.rs native/http-api-server/src/main.rs apps/electron/src/main/lib/http-api-handler.ts apps/electron/src/main/lib/working-auth-store.ts apps/electron/src/main/lib/working-auth-store.test.ts apps/electron/src/main/lib/http-api-server.ts
      git commit -m "feat(auth): move Working session ownership to Rust"

---

### Task 4: 实现 WorkingGateway 认证、用户、工作区和会话路由

**Files:**

- Create: native/http-api-server/src/working_gateway.rs
- Create: native/http-api-server/src/working_gateway_tests.rs
- Modify: native/http-api-server/src/main.rs
- Modify: apps/electron/src/main/lib/working-api-client.ts
- Modify: apps/electron/src/main/lib/working-api-client.test.ts

**Interfaces:**

    pub fn handle_working_gateway_request(
        gateway: &WorkingGateway,
        method: &str,
        target: &str,
        body: Option<&str>,
    ) -> Result<GatewayResponse, GatewayError>;

- Consumes: AuthSession 和 EduApiClient。
- Produces: 本机 /api/working/auth-state、login、register、send-verification-code、
  verify-password-reset-code、reset-password、logout、current-user、workspaces、
  sessions、session history、skills、feedback、settings 和 check-in 路由。

- [ ] **Step 1: Write the failing BDD tests**

  测试本机路由：

  - 未登录访问受保护路由返回 401，不触发远端请求；
  - login/register/code/reset 只调用对应 Auth path；
  - login 并发第二次返回 429；
  - 401 请求完成一次 refresh 后只重放一次；
  - 解析 query、分页、订单 ID、run ID 和 workspace 字段时拒绝越界和路径穿越；
  - 成功响应保持现有 Renderer 类型兼容，错误响应包含公开 code。

- [ ] **Step 2: Run the focused Rust and client tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml working_gateway
      bun test apps/electron/src/main/lib/working-api-client.test.ts

  Expected: FAIL，因为本机 WorkingGateway 尚未接管这些路由。

- [ ] **Step 3: Implement the gateway and local facade**

  在 main.rs 将 /api/working/* 路由优先交给 WorkingGateway。将 Electron
  WorkingApiClient 的 request、login、refresh 和 token header 逻辑改成
  LocalRustWorkingClient：只访问 127.0.0.1 的 HTTP API，保留现有 normalize
  函数和 public 方法，删除远端 baseUrl 请求和 Electron 侧 refresh timer。

  login、register、验证码、找回密码仍由现有 CopisWorkingLoginDialog 调用原 IPC，
  IPC 只把表单转发到本地 Rust；不改变表单字段和视觉布局。

- [ ] **Step 4: Run focused tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml working_gateway
      bun test apps/electron/src/main/lib/working-api-client.test.ts

  Expected: PASS；测试中的 fetch URL 全部是本机 Rust 地址，不出现远端 edu-api URL。

- [ ] **Step 5: Commit**

      git add native/http-api-server/src/working_gateway.rs native/http-api-server/src/working_gateway_tests.rs native/http-api-server/src/main.rs apps/electron/src/main/lib/working-api-client.ts apps/electron/src/main/lib/working-api-client.test.ts
      git commit -m "feat(rust): route Working account and workspace APIs"

---

### Task 5: 将技能、支付、图片、订单和反馈请求切换到 EduApiClient

**Files:**

- Modify: native/http-api-server/src/skill_market.rs
- Modify: native/http-api-server/src/skill_market_tests.rs
- Modify: native/http-api-server/src/working_payment.rs
- Modify: native/http-api-server/src/working_payment_tests.rs
- Modify: native/http-api-server/src/working_model.rs
- Modify: native/http-api-server/src/main.rs
- Modify: native/http-api-server/src/working_gateway.rs

**Interfaces:**

- Consumes: WorkingGateway、AuthSession、EduApiClient。
- Produces: 技能市场、expert skills、钻石套餐、支付订单、VIP 升级、订单支付、
  图片生成、反馈和模型延迟均由 Rust 直接调用 edu-api。
- Removes: BridgeWorkingBackend 对业务请求的 Electron 反向调用；
  skill_market.rs 中 request_working_http 的远端直连实现。

- [ ] **Step 1: Write the failing boundary and behavior tests**

  更新 skill_market 和 payment 测试，注入 mock EduApiClient，断言请求带 Rust
  AuthSession 的 Authorization，支付写请求上游失败时只调用一次；断言 Electron
  bridge 不再收到 /api/internal/working-auth/request。为图片生成、反馈、订单
  删除补充 503 单次调用测试。

- [ ] **Step 2: Run tests to verify RED**

      cargo test --manifest-path native/http-api-server/Cargo.toml skill_market
      cargo test --manifest-path native/http-api-server/Cargo.toml working_payment

  Expected: FAIL，因为现有技能和支付实现仍依赖 Electron bridge 或旧 token 同步。

- [ ] **Step 3: Implement direct Rust ownership**

  将 WorkingBackend 改为持有 Arc<WorkingGateway> 或 EduApiClient 的窄接口；
  payment capability 只绑定本地 session 和支付上下文；所有上游 Authorization
  由 EduApiClient 生成。删除明文 token 在 BridgeWorkingBackend 请求体中的路径。
  保留本地支付工作区、订单状态和现有 capability 生命周期。

- [ ] **Step 4: Run focused tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml skill_market
      cargo test --manifest-path native/http-api-server/Cargo.toml working_payment
      cargo test --manifest-path native/http-api-server/Cargo.toml edu_api_client

  Expected: PASS，且静态边界测试不再发现 skill_market 远端旁路。

- [ ] **Step 5: Commit**

      git add native/http-api-server/src/skill_market.rs native/http-api-server/src/skill_market_tests.rs native/http-api-server/src/working_payment.rs native/http-api-server/src/working_payment_tests.rs native/http-api-server/src/working_model.rs native/http-api-server/src/main.rs native/http-api-server/src/working_gateway.rs
      git commit -m "refactor(rust): route Working business APIs through gateway"

---

### Task 6: 收紧 Electron 主进程、stdio bridge 和浏览器调用面

**Files:**

- Modify: apps/electron/src/main/lib/working-api-client.ts
- Modify: apps/electron/src/main/lib/working-api-service.ts
- Modify: apps/electron/src/main/lib/http-api-handler.ts
- Modify: apps/electron/src/main/ipc.ts
- Modify: apps/electron/src/preload/index.ts
- Modify: apps/electron/src/renderer/lib/http-api-bridge.ts
- Modify: apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx only if the existing IPC contract needs a local Rust error mapping
- Modify: apps/electron/src/main/lib/working-api-client.test.ts
- Modify: apps/electron/src/main/lib/http-api-handler.test.ts

**Interfaces:**

- Consumes: local Rust /api/working/* API and private auth-storage bridge.
- Produces: existing Working IPC method names and response types, with no remote
  network request from Electron.

- [ ] **Step 1: Write the failing tests**

  给 WorkingApiClient 注入 fetch，断言所有 auth、user、workspace、session、skill、
  feedback、payment、image 和 order method 的 URL 都是本机 Rust；断言 headers
  不含用户 Authorization token。给 http-api-handler 测试断言旧
  /api/internal/working-auth/request 返回 404 或 disabled，auth-storage 路径
  只能通过 stdio dispatch 依赖调用。

- [ ] **Step 2: Run tests to verify RED**

      bun test apps/electron/src/main/lib/working-api-client.test.ts
      bun test apps/electron/src/main/lib/http-api-handler.test.ts

  Expected: FAIL，因为当前 Electron client 仍直接请求远端或向本地 Rust 转发
  带 token 的业务请求。

- [ ] **Step 3: Implement the local facade**

  保留 WorkingApiClient 的数据 normalization 和 public method，统一调用本地
  Rust client。将 getWorkingAuthState 改为本机 auth-state；logout 改为本机
  logout；删除 Electron 侧 refresh timer、OIDC token exchange 和远端请求重放。
  http-api-handler 删除业务 Working facade 入口，仅保留 safeStorage 适配和已有
  非 edu-api 的本地服务。

  Preload、IPC 和登录组件继续使用当前方法名，避免 renderer UI 改动。任何
  Rust 返回的 429、401、503 都原样映射为 UI 可展示的错误 code。

- [ ] **Step 4: Run focused tests**

      bun test apps/electron/src/main/lib/working-api-client.test.ts
      bun test apps/electron/src/main/lib/http-api-handler.test.ts
      bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts

  Expected: PASS，且原生登录、注册、找回密码 contract 仍通过。

- [ ] **Step 5: Commit**

      git add apps/electron/src/main/lib/working-api-client.ts apps/electron/src/main/lib/working-api-service.ts apps/electron/src/main/lib/http-api-handler.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/lib/http-api-bridge.ts apps/electron/src/main/lib/working-api-client.test.ts apps/electron/src/main/lib/http-api-handler.test.ts
      git commit -m "refactor(electron): use local Rust Working facade"

---

### Task 7: 迁移 Pi Worker 和 Working Model SSE

**Files:**

- Create: native/http-api-server/src/working_model_proxy.rs
- Create: native/http-api-server/src/working_model_proxy_tests.rs
- Modify: native/http-api-server/src/pi_rpc.rs
- Modify: native/http-api-server/src/pi_rpc_tests.rs
- Modify: apps/electron/src/main/lib/agent-rpc-service.ts
- Modify: apps/electron/src/main/lib/agent-orchestrator.ts
- Modify: apps/electron/src/main/lib/agent-runtime-env.ts
- Modify: apps/electron/src/main/lib/agent-rpc-service.test.ts
- Modify: apps/electron/src/main/lib/agent-runtime-env.test.ts
- Modify: packages/shared/src/types/working.ts

**Interfaces:**

    pub struct WorkingModelCapability {
        pub capability: String,
        pub session_id: String,
        pub model_id: String,
        pub expires_at: u64,
    }

    pub fn proxy_working_model_sse(
        proxy: &WorkingModelProxy,
        capability: &str,
        request_body: &[u8],
    ) -> Result<SseStream, WorkingModelError>;

- Consumes: AuthSession、EduApiClient、现有 Pi worker capability 生命周期。
- Produces: Pi Worker 只调用本地代理；Rust 顺序转发 edu-api SSE，并在所有退出
  路径撤销 capability。

- [ ] **Step 1: Write the failing tests**

  测试：

  - Worker 配置不含 access token、refresh token、Authorization header 或远端 URL；
  - 启动成功后 capability 只允许对应 session 和模型使用一次；
  - Worker 启动失败、stop、complete、panic/异常和超时都会撤销 capability；
  - SSE data 顺序、空 data、error 和终止事件不重复、不丢失；
  - edu-api 401 只触发 AuthSession 的一次 refresh，不在 Worker 侧重试。

- [ ] **Step 2: Run tests to verify RED**

      cargo test --manifest-path native/http-api-server/Cargo.toml working_model_proxy
      cargo test --manifest-path native/http-api-server/Cargo.toml pi_rpc
      bun test apps/electron/src/main/lib/agent-rpc-service.test.ts apps/electron/src/main/lib/agent-runtime-env.test.ts

  Expected: FAIL，因为 Pi config 当前仍可能包含 Working JWT 或远端模型地址。

- [ ] **Step 3: Implement the proxy**

  在 Rust PiWorkerManager 启动前创建绑定 capability，并将本地代理方法写入
  worker config。模型请求进入 WorkingModelProxy 后再从 AuthSession 取得 token，
  使用 EduApiClient 连接 edu-api internal working-model endpoint。使用明确的
  SSE frame parser，逐帧写给本机调用者；在 finish、stop、启动错误和异常清理
  capability。

  删除 Electron agent-rpc-service 和 agent-orchestrator 给 Pi 注入 Working JWT、
  remote baseUrl 或自行发送 Working model 请求的路径，保留普通第三方 Provider
  的既有行为。

- [ ] **Step 4: Run focused tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml working_model_proxy
      cargo test --manifest-path native/http-api-server/Cargo.toml pi_rpc
      bun test apps/electron/src/main/lib/agent-rpc-service.test.ts apps/electron/src/main/lib/agent-runtime-env.test.ts

  Expected: PASS；SSE 顺序和 capability 生命周期符合验收文档。

- [ ] **Step 5: Commit**

      git add native/http-api-server/src/working_model_proxy.rs native/http-api-server/src/working_model_proxy_tests.rs native/http-api-server/src/pi_rpc.rs native/http-api-server/src/pi_rpc_tests.rs apps/electron/src/main/lib/agent-rpc-service.ts apps/electron/src/main/lib/agent-orchestrator.ts apps/electron/src/main/lib/agent-runtime-env.ts apps/electron/src/main/lib/agent-rpc-service.test.ts apps/electron/src/main/lib/agent-runtime-env.test.ts packages/shared/src/types/working.ts
      git commit -m "feat(rust): proxy Working model requests for Pi workers"

---

### Task 8: 核对 ai-education Auth/edu-api 契约

**Files:**

- Review: /Volumes/RC500/dev/ai-education/backend/modules/auth
- Review: /Volumes/RC500/dev/ai-education/backend/modules/edu-api
- Review: /Volumes/RC500/dev/ai-education/deploy/fix-test/compose.yaml
- Modify only if a contract test proves the server behavior differs from the agreed interface

**Interfaces:**

- Consumes: Rust AuthSession and WorkingGateway request/response contracts.
- Produces: Auth login/register/refresh/send-code/verify-code/password-reset、
  OIDC discovery/token/userinfo/JWKS 和 edu-api Working/model/payment paths 的实测
  contract evidence。

- [ ] **Step 1: Run existing contract tests before server edits**

      cd /Volumes/RC500/dev/ai-education
      rg -n "auth/login|auth/register|oauth/token|working-model|working-desktop" backend/modules deploy/fix-test
      ./deploy/fix-test/up.sh
      ./deploy/fix-test/smoke.sh
      docker compose -f deploy/fix-test/compose.yaml ps

  Record the actual status, response envelope, refresh rotation behavior and required
  environment variables. Do not change ai-education only because a path name looks
  different in an old document.

- [ ] **Step 2: Write failing cross-repository contract tests when needed**

  Add a focused Rust mock or Go httptest contract for every mismatch found, including
  login response token fields, refresh response fields, user identity mapping, model
  SSE content type and payment response envelope. Run the smallest failing test first.

- [ ] **Step 3: Make the minimal server-side fix**

  If a mismatch is real, modify only the owning Auth or edu-api handler and its
  fix-test compose environment. Keep OIDC issuer, audience, JWKS and client redirect
  configuration explicit; never place secrets in source, manifest, logs or images.

- [ ] **Step 4: Run server and smoke validation**

      cd /Volumes/RC500/dev/ai-education
      go test ./...
      ./deploy/fix-test/up.sh
      ./deploy/fix-test/smoke.sh
      docker compose -f deploy/fix-test/compose.yaml ps

- [ ] **Step 5: Commit only ai-education contract changes**

      git add backend/modules deploy/fix-test
      git commit -m "test(auth): align edu-api gateway contracts"

---

### Task 9: 联合验证、开发容器构建和真实 UI 交付

**Files:**

- Review only: all files changed by Tasks 1-8.
- Update: docs/superpowers/acceptance/2026-08-19-copis-rust-edu-api-gateway.md with executed evidence.

**Interfaces:**

- Consumes: all previous tasks.
- Produces: 可复现的自动化结果、开发 fix-test 新容器 smoke 结果和用户真实窗口
  验收记录。

- [ ] **Step 1: Run Rust focused and full tests**

      cargo test --manifest-path native/http-api-server/Cargo.toml edu_api_client
      cargo test --manifest-path native/http-api-server/Cargo.toml auth_session
      cargo test --manifest-path native/http-api-server/Cargo.toml working_gateway
      cargo test --manifest-path native/http-api-server/Cargo.toml skill_market
      cargo test --manifest-path native/http-api-server/Cargo.toml working_payment
      cargo test --manifest-path native/http-api-server/Cargo.toml working_model_proxy
      cargo test --manifest-path native/http-api-server/Cargo.toml

- [ ] **Step 2: Run Electron checks**

      bun test apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts
      bun test apps/electron/src/main/lib/working-api-client.test.ts
      bun test apps/electron/src/main/lib/http-api-handler.test.ts
      bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts
      bun run typecheck
      bun run --filter='@copis/electron' build:main
      bun run --filter='@copis/electron' build:preload
      bun run --filter='@copis/electron' build:renderer

- [ ] **Step 3: Run the development server container path**

      cd /Volumes/RC500/dev/ai-education
      ./deploy/fix-test/up.sh
      ./deploy/fix-test/smoke.sh
      docker compose -f deploy/fix-test/compose.yaml ps

  Confirm the new container image is the one serving Auth and edu-api, not an old
  running container or deploy smoke process.

- [ ] **Step 4: Perform static security review**

      git diff --check
      rg -n "COPIS_BACKEND_URL|Authorization|access_token|refresh_token|client_secret|password|verification" apps/electron/src/main native/http-api-server/src packages/shared/src

  Review every match and verify it is either a type name, a local Rust boundary,
  safeStorage adapter or a test assertion. Reject any credential in logs, Renderer
  state, Pi config or public response.

- [ ] **Step 5: Ask for real Electron window confirmation**

  Start the development application. In the actual Electron window, confirm:
  native login, registration, verification code, password reset, logout, Working
  workspace/history, Agent streaming, image generation and payment. Also confirm
  that a repeated click during login shows a fast busy/429 state and does not leave
  the UI in indefinite processing.

- [ ] **Step 6: Update acceptance evidence and deliver**

  Fill the acceptance document with command output summaries, upstream request
  counters, smoke container status, known residual risks and the user's UI
  confirmation result. Inspect the final scoped diff, stage only intended files,
  and push only after the requested GitHub delivery checkpoint is approved.
