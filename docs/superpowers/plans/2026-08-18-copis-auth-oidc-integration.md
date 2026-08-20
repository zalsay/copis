# Copis 与 ai-edu OIDC 登录接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Copis Working 登录替换为 ai-education Auth 的 OIDC Authorization Code + PKCE，并让 edu-api 接受 Auth 签发的 RS256 access token。

**Architecture:** Copis 主进程拥有 OAuth 状态机、loopback 回调服务器、token 兑换和加密凭据；renderer 只通过高层 IPC 触发登录并接收不含 token 的 `WorkingAuthState`。edu-api 在保留迁移期 HS256 兼容的同时增加基于 Auth JWKS 和 `auth_subjects` 的 RS256 验证，保证新 token 能访问现有 Working 业务接口。

**Tech Stack:** Electron main/preload, React 18, Jotai, TypeScript, Bun test, Go 1.25, Gin, GORM, Go standard library crypto/http.

## Global Constraints

- OAuth flow 只使用 Authorization Code + PKCE S256；不实现 implicit flow、password grant 或 client secret。
- `copis-desktop` 使用固定回调 `http://127.0.0.1:43123/oauth/callback`，redirect URI 必须精确匹配。
- Renderer、Rust bridge 和普通 localStorage 不得接收或保存密码、授权码、Access Token、Refresh Token。
- Token 文件继续使用 `~/.copis/working-auth.json` 和 Electron `safeStorage`；旧 token 迁移期兼容，新登录只生成 `provider=oidc`。
- edu-api RS256 验证必须固定检查 issuer、audience、algorithm、kid、token type、subject、issued-at 和 expiry；失败不得降级为 HS256。
- 不新增第三方依赖；不修改 `README.md` 或 `AGENTS.md`。
- 每个行为先写失败测试并运行到预期失败，再写最小实现，最后运行聚焦测试。
- 保留当前工作树中与认证无关的用户修改，不执行 reset、checkout、清理或全量暂存。

---

### Task 1: 建立 OAuth 协议客户端边界

**Files:**
- Create: `apps/electron/src/main/lib/working-oidc-client.test.ts`
- Create: `apps/electron/src/main/lib/working-oidc-client.ts`

**Interfaces:**
- `createPkcePair(randomBytes?: (size: number) => Uint8Array): Promise<{ state: string; codeVerifier: string; codeChallenge: string }>`
- `buildWorkingAuthorizationUrl(input: { authorizationEndpoint: string; clientId: string; redirectUri: string; state: string; codeChallenge: string; scope: string }): string`
- `exchangeWorkingAuthorizationCode(input: { tokenEndpoint: string; clientId: string; redirectUri: string; code: string; codeVerifier: string; fetchImpl?: FetchLike }): Promise<WorkingOAuthTokenSet>`
- `WorkingOidcClient.authorize(): Promise<WorkingOAuthTokenSet>`，负责 discovery、loopback callback、系统浏览器打开和 token 兑换。

- [ ] **Step 1: Write the failing test**

  在 `working-oidc-client.test.ts` 覆盖：PKCE challenge 是 BASE64URL(SHA-256(verifier))；authorization URL 包含固定 client、redirect、scope、state 和 S256；token exchange 使用 `application/x-www-form-urlencoded` 且不发送 client secret；错误的 discovery issuer、OAuth error、缺少 access token 和错误 state 都抛出可识别错误。

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test apps/electron/src/main/lib/working-oidc-client.test.ts`

  Expected: FAIL，因为 `working-oidc-client.ts` 和上述导出尚不存在。

- [ ] **Step 3: Write minimal implementation**

  使用 Node `crypto` 生成随机 state/verifier，使用 `createHash('sha256')` 计算 challenge，使用 `URLSearchParams` 构建请求。OIDC discovery 从 `${issuer}/.well-known/openid-configuration` 加载，并校验返回的 `issuer` 与配置一致。loopback server 只接受 `/oauth/callback` 的一次 GET，保存 query 后返回简短 HTML 并关闭；超时、客户端取消、监听失败和非 2xx token 响应均关闭 server 并抛出错误。生产默认回调端口为 `43123`，测试通过注入 server factory 使用临时端口。

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test apps/electron/src/main/lib/working-oidc-client.test.ts`

  Expected: PASS，且输出不包含 token 或 verifier 内容。

- [ ] **Step 5: Commit**

  本任务完成后只提交 OAuth 客户端文件：

  ```bash
  git add apps/electron/src/main/lib/working-oidc-client.ts apps/electron/src/main/lib/working-oidc-client.test.ts
  git commit -m "feat(auth): add Copis OIDC PKCE client"
  ```

---

### Task 2: 接入加密 token store 和 Working API refresh

**Files:**
- Modify: `apps/electron/src/main/lib/working-auth-store.ts`
- Modify: `apps/electron/src/main/lib/working-api-client.ts`
- Modify: `apps/electron/src/main/lib/working-api-client.test.ts`

**Interfaces:**
- `WorkingAuthProvider = 'legacy' | 'oidc'`
- `WorkingTokenStore.getProvider?(): WorkingAuthProvider | null`
- `WorkingTokenStore.save(token, user?, refreshToken?, provider?): void`
- `WorkingApiClient.loginWithOAuth(openExternal: (url: string) => Promise<void>): Promise<WorkingLoginResult>`

- [ ] **Step 1: Write the failing test**

  添加测试验证 OAuth 登录调用 discovery、authorization、token endpoint 和 `/api/users/me`，保存 provider=oidc；OAuth refresh 使用 discovery token endpoint、发送 `grant_type=refresh_token`、轮换并保存新的 refresh token；旧 token 的 refresh 测试继续要求 `/api/auth/refresh`。测试还要验证 token 仍只通过 token store 被读取。

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test apps/electron/src/main/lib/working-api-client.test.ts`

  Expected: 新增 OAuth 测试 FAIL，因为 client 尚未拥有 OAuth 登录方法和 provider-aware refresh。

- [ ] **Step 3: Write minimal implementation**

  在 `working-auth-store.ts` 的 JSON 中持久化 `provider`，保持旧文件没有 provider 时按 token issuer 推断为 legacy。`WorkingApiClient.loginWithOAuth` 使用 `WorkingOidcClient`，兑换后保存 access/refresh token，调用现有 `getCurrentUser` 并同步 Rust token。`performRefreshAccessToken` 按 provider 选择 Auth `/oauth/token` 或旧 `/api/auth/refresh`；OIDC 请求发送 form-urlencoded，禁止 Authorization header。401 仍清理认证信息和停止自动刷新。

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test apps/electron/src/main/lib/working-api-client.test.ts`

  Expected: Copis Working API client 全部通过。

- [ ] **Step 5: Commit**

  ```bash
  git add apps/electron/src/main/lib/working-auth-store.ts apps/electron/src/main/lib/working-api-client.ts apps/electron/src/main/lib/working-api-client.test.ts
  git commit -m "feat(auth): persist Copis OIDC credentials"
  ```

---

### Task 3: 同步 shared IPC、preload 和 renderer 登录入口

**Files:**
- Modify: `packages/shared/src/types/working.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.css`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.visual-contract.test.ts`

**Interfaces:**
- New IPC channel: `WORKING_IPC_CHANNELS.LOGIN_OIDC = 'working:login-oidc'`
- New preload method: `loginWorkingWithOAuth(): Promise<WorkingAuthState>`
- Main IPC handler calls `getWorkingApiClient().loginWithOAuth((url) => shell.openExternal(url))` and never returns token data.

- [ ] **Step 1: Write the failing test**

  更新登录页 contract，断言全屏入口显示 OAuth 登录按钮、没有邮箱/密码输入和旧注册提交调用；更新 preload/shared contract，断言 `LOGIN_OIDC` 与 `loginWorkingWithOAuth` 存在。保留 Showcase、错误提示、busy/重试和可关闭设置入口语义。

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.visual-contract.test.ts`

  Expected: FAIL，因为当前 renderer 仍渲染密码表单且没有 OAuth IPC。

- [ ] **Step 3: Write minimal implementation**

  在 shared 类型、main handler、preload 类型和实现四处同步新 IPC。登录页右侧保留 Copis 品牌与已确认的双栏 Showcase，只提供“使用 ai-edu 账号登录”按钮；点击时调用 OAuth IPC，显示 loading/error 状态。删除 renderer 对注册、验证码和找回密码 IPC 的调用与相关状态，避免继续向旧 `/api/auth/*` 发送凭据。可关闭模式保留关闭按钮和 Escape 行为。

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.visual-contract.test.ts`

  Expected: PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add packages/shared/src/types/working.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.css apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.visual-contract.test.ts
  git commit -m "feat(auth): switch Copis login entry to OAuth"
  ```

---

### Task 4: 让 edu-api 验证 Auth RS256 access token

**Files:**
- Create: `/Volumes/RC500/dev/ai-education/backend/modules/edu-api/middleware/oidc_verifier.go`
- Create: `/Volumes/RC500/dev/ai-education/backend/modules/edu-api/middleware/oidc_verifier_test.go`
- Modify: `/Volumes/RC500/dev/ai-education/backend/modules/edu-api/middleware/auth.go`
- Modify: `/Volumes/RC500/dev/ai-education/backend/modules/edu-api/middleware/auth_test.go`
- Modify: `/Volumes/RC500/dev/ai-education/backend/modules/edu-api/module.yaml`

**Interfaces:**
- `AuthMiddleware()` accepts both legacy HS256 and configured Auth RS256 access tokens.
- `OIDCVerifier` validates a JWT using cached JWKS and returns the mapped `models.User` identity.
- Required env: `AUTH_ISSUER`, `AUTH_JWKS_URL`, `AUTH_AUDIENCE`; optional `AUTH_JWKS_CACHE_TTL` defaults to five minutes.

- [ ] **Step 1: Write the failing test**

  使用 httptest JWKS server 和临时 RSA key 生成合法 token，测试合法 issuer/audience/kid/sub 映射到 `auth_subjects` 后写入 Gin context；分别测试错误签名、HS256 header、错误 issuer/audience、过期、未来 issued-at、refresh token type、未知 kid 和未知 subject 均返回 401。保留旧 HS256 middleware 测试通过。

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd /Volumes/RC500/dev/ai-education/backend/modules/edu-api && go test ./middleware`

  Expected: 新增 RS256 测试 FAIL，因为当前 middleware 不读取 Auth JWKS 或 `auth_subjects`。

- [ ] **Step 3: Write minimal implementation**

  用 Go 标准库解析 JWT 三段结构，拒绝 `alg` 不为 RS256 的 token；从 JWKS 读取 RSA public key，按 `kid` 缓存并在缓存失效时刷新，验证 PKCS#1 v1.5 SHA-256 签名与时间/issuer/audience/type claims。验证成功后用 `database.DB.Raw` 查询 `auth_subjects JOIN users`，将用户字段写入现有 context。RS256 校验失败直接返回 401，不调用旧 HS256 parser。未配置 OIDC 环境时维持当前旧逻辑，便于本地测试和迁移。

- [ ] **Step 4: Run test to verify it passes**

  Run: `cd /Volumes/RC500/dev/ai-education/backend/modules/edu-api && go test ./middleware`

  Expected: middleware 单元测试全部通过。

- [ ] **Step 5: Add deployment environment contract**

  在 `backend/modules/edu-api/module.yaml` 的运行环境契约中声明 Auth issuer/JWKS/audience；不写入私钥、客户端 secret 或 token。同步 fix-test compose 的测试环境，仅使用测试 issuer/JWKS 配置。

- [ ] **Step 6: Commit**

  ```bash
  cd /Volumes/RC500/dev/ai-education
  git add backend/modules/edu-api/middleware backend/modules/edu-api/module.yaml deploy/fix-test/compose.yaml
  git commit -m "feat(edu-api): accept Auth RS256 access tokens"
  ```

---

### Task 5: 联合验证与交付审查

**Files:**
- Review only: all files changed by Tasks 1-4.

- [ ] **Step 1: Run Copis focused tests**

  ```bash
  cd /Volumes/RC500/dev/copis
  bun test apps/electron/src/main/lib/working-oidc-client.test.ts
  bun test apps/electron/src/main/lib/working-api-client.test.ts
  bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.visual-contract.test.ts
  ```

- [ ] **Step 2: Run Copis typecheck and builds**

  ```bash
  bun run typecheck
  bun run --filter='@copis/electron' build:main
  bun run --filter='@copis/electron' build:preload
  bun run --filter='@copis/electron' build:renderer
  ```

- [ ] **Step 3: Run edu-api validation**

  ```bash
  cd /Volumes/RC500/dev/ai-education/backend/modules/edu-api
  go test ./middleware
  go test ./...
  make build-edu-api-bin
  ```

- [ ] **Step 4: Review security and diff**

  检查 `git diff --check`、token/密码/secret 是否出现在日志或 renderer 类型、OAuth callback server 是否所有路径关闭、JWKS 是否严格绑定 issuer/audience/kid、变更是否未触碰无关用户文件。运行现有 `@code-simplifier` 流程（若仓库提供）并仅保留能降低复杂度的改动。

- [ ] **Step 5: Request review and report residual UI validation**

  请求代码审查后再交付。自动化验证完成后，用户仍需在实际 Electron 窗口确认：点击 OAuth 登录、系统浏览器登录/授权、回调返回 Copis、取消/错误提示及再次打开应用的登录状态。截图不能替代该确认。
