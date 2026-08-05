# Copis COS Functional Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Electron 使用统一的 COS manifest、下载校验和 active 版本生命周期管理 OfficeCLI 与 Rust HTTP API 模块。

**Architecture:** 新增纯函数 manifest 解析器，把 `platforms -> modules` 转换为当前平台的标准模块 artifact；现有文件存储层继续负责 cache/version/active 原子写入，功能模块管理器负责 COS 网络和安装编排。Rust API 进程管理器从 active module 取入口，使用候选端口健康检查完成更新与回滚；渲染层沿用现有功能模块 IPC 展示两条模块状态。

**Tech Stack:** Bun、TypeScript、Electron IPC、Jotai、Node `fetch`/`fs`/`child_process`、Rust HTTP API、腾讯云 COS SDK（只在发布脚本中使用，先检索并锁定版本）。

---

## 文件和边界

| 文件 | 职责 |
| --- | --- |
| `packages/shared/src/types/functional-module.ts` | manifest、artifact、状态和 IPC 公共类型 |
| `apps/electron/src/main/lib/functional-module-manifest.ts` | 纯 JSON 解析、平台选择、URL/字段校验 |
| `apps/electron/src/main/lib/functional-module-store.ts` | 模块 cache、版本目录、active 指针和回滚指针 |
| `apps/electron/src/main/lib/functional-module-manager.ts` | COS manifest 获取、下载、SHA256、安装和状态查询 |
| `apps/electron/src/main/lib/http-api-server.ts` | active Rust API 启动、候选健康检查、切换和恢复 |
| `apps/electron/src/main/index.ts` | 启动阶段触发模块初始化和 Rust API 服务 |
| `apps/electron/src/renderer/atoms/functional-modules.ts` | 两个模块的状态、进度和安装动作 |
| `apps/electron/src/renderer/components/settings/FunctionalModulesCard.tsx` | OfficeCLI/Rust API 状态和操作 UI |
| `apps/electron/scripts/build-http-api-server.ts` | 仅生成本地开发/COS 发布输入，不再作为正式默认 runtime 来源 |
| `apps/electron/scripts/build-functional-module-manifest.ts` | 根据平台二进制生成 manifest 和 SHA256 |
| `apps/electron/scripts/publish-functional-modules.ts` | 先上传不可变二进制，再上传 manifest |
| `apps/electron/src/main/lib/*test.ts` | BDD 单元和进程边界回归 |

不修改 `AGENTS.md`、`README.md`，不触碰与本功能无关的现有 dirty files。

## Task 1: 共享 manifest 类型和纯解析器

**Files:**
- Modify: `packages/shared/src/types/functional-module.ts`
- Modify: `packages/shared/src/types/index.ts`（若当前未 re-export 新类型）
- Create: `apps/electron/src/main/lib/functional-module-manifest.ts`
- Create: `apps/electron/src/main/lib/functional-module-manifest.test.ts`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Write the failing BDD tests**

在 `functional-module-manifest.test.ts` 固定以下输入和行为：

```ts
const manifest = {
  schema: 1,
  channel: 'stable',
  client: { minVersion: '0.16.13' },
  platforms: {
    'darwin-arm64': {
      modules: {
        officecli: {
          version: '1.2.3',
          url: 'https://download.example/officecli-1.2.3',
          sha256: 'a'.repeat(64),
          size: 12,
          format: 'binary',
          entrypoint: 'bin/officecli',
          required: false,
        },
        'rust-http-api': {
          version: '0.2.0',
          url: 'https://download.example/rust-http-api-0.2.0',
          sha256: 'b'.repeat(64),
          size: 24,
          format: 'binary',
          entrypoint: 'bin/copis-http-api-server',
          required: true,
        },
      },
    },
  },
}
```

测试 `parseFunctionalModuleManifest(JSON.stringify(manifest), '0.16.17', 'darwin', 'arm64')` 返回两个 artifact；测试缺 platform、缺 sha256、HTTP URL、路径穿越 entrypoint、旧 client version 时抛出中文可诊断错误；测试 `linux + x64` 只返回对应平台而不误用 macOS 模块。

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
bun test apps/electron/src/main/lib/functional-module-manifest.test.ts
```

Expected: FAIL because the parser module and manifest types do not yet exist.

- [ ] **Step 3: Add the exact shared contract**

在 shared 类型中新增：

```ts
export type FunctionalModuleName = 'officecli' | 'rust-http-api' | (string & {})
export type FunctionalModuleFormat = 'binary'

export interface FunctionalModuleManifestArtifact {
  version: string
  url: string
  sha256: string
  size: number
  format: FunctionalModuleFormat
  entrypoint: string
  required: boolean
}

export interface FunctionalModuleManifestPlatform {
  modules: Record<string, FunctionalModuleManifestArtifact>
}

export interface FunctionalModuleManifest {
  schema: number
  channel: string
  client?: { minVersion?: string }
  platforms: Record<string, FunctionalModuleManifestPlatform>
}
```

扩展 `FunctionalModuleArtifact` 为包含 `size`、`format`、`required` 的已解析 artifact，并增加 `FunctionalModulePlatformKey` 与 `getFunctionalModulePlatformKey()` 所需的导出类型。保持 `FunctionalModuleInstallInput` 和 IPC channel 名称兼容。

- [ ] **Step 4: Implement the pure parser**

在 `functional-module-manifest.ts` 实现：

```ts
export function parseFunctionalModuleManifest(
  json: string,
  clientVersion: string,
  platform: FunctionalModulePlatform,
  arch: FunctionalModuleArchitecture,
): FunctionalModuleArtifact[]

export function getFunctionalModuleManifestUrl(): string | undefined
```

解析器只做 JSON/字段/URL/版本兼容校验和平台选择，不执行网络或文件写入。允许 HTTPS，只有 `localhost`、`127.0.0.1` 和 `[::1]` 的开发 URL 允许 HTTP；`entrypoint` 必须是相对路径且不能包含 `..`；`size` 与 SHA256 必须与类型约束一致。模块 artifact 的 `name` 来自 map key，禁止从远程数据覆盖目标模块名。

- [ ] **Step 5: Run focused tests and typecheck shared package**

```bash
bun test apps/electron/src/main/lib/functional-module-manifest.test.ts
bun run --filter='@copis/shared' typecheck
```

Expected: all parser scenarios pass and shared typecheck passes.

- [ ] **Step 6: Increment the shared package patch version**

将当前 `@copis/shared` patch 版本递增 1，保持 workspace lockfile 与 package metadata 一致；只修改该包需要的版本记录。

- [ ] **Step 7: Commit the isolated protocol change**

```bash
git add packages/shared/src/types/functional-module.ts packages/shared/src/types/index.ts packages/shared/package.json apps/electron/src/main/lib/functional-module-manifest.ts apps/electron/src/main/lib/functional-module-manifest.test.ts bun.lock
git diff --cached --check
git commit -m "feat: add COS functional module manifest contract"
```

## Task 2: 将模块存储和管理器改为统一 COS 下载

**Files:**
- Modify: `apps/electron/src/main/lib/functional-module-store.ts`
- Modify: `apps/electron/src/main/lib/functional-module-store.test.ts`
- Replace behavior in: `apps/electron/src/main/lib/functional-module-manager.ts`
- Modify: `apps/electron/src/main/lib/functional-module-manager.test.ts`
- Modify: `apps/electron/src/main/lib/config-paths.ts`（仅在需要新增 manifest 缓存路径时）
- Modify: `apps/electron/package.json`

- [ ] **Step 1: Replace the old OfficeCLI release tests with COS fixture tests**

在 manager test 中构造一个 manifest `Response` 和两个 binary `Response`，覆盖：

```text
Given COS manifest 同时提供 officecli 与 rust-http-api
When installFunctionalModule({ name: 'officecli' })
Then 请求 manifest 后只下载 officecli，active.json 的 name 为 officecli

Given rust-http-api binary 的 SHA256 错误
When installFunctionalModule({ name: 'rust-http-api' })
Then 抛出校验错误，旧 active 文件不变且 partial 被删除

Given 两次安装相同 module/version/sha256
When 第二次安装
Then 不重复下载 binary，并返回 updateAvailable=false
```

删除只针对 GitHub `/releases/latest`、`SHA256SUMS` 和 mirror fallback 的旧断言；保留现有缓存原子性和进度阶段断言。

- [ ] **Step 2: Run manager/store tests to capture the expected failures**

```bash
bun test apps/electron/src/main/lib/functional-module-store.test.ts
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
```

Expected: old manager still requests GitHub/mirror and cannot resolve `rust-http-api` from COS.

- [ ] **Step 3: Extend the store package metadata without changing the directory contract**

将 `FunctionalModulePackage` 扩展为保存 `size`、`format`、`required`；`module.json` 和 `module-lock.json` 必须比较这些字段，避免同一个 SHA256 被错误当成不同入口。保留 `cache/<name>/<sha256>`、`versions/<name>/<version>-<sha256>` 和 `active.json` 的路径布局。

新增一个仅用于测试和 Rust 更新恢复的函数：

```ts
export function readActiveFunctionalModules(rootDir: string): Record<string, ActiveFunctionalModule>
```

它对损坏记录跳过而不是抛出，不能返回 rootDir 外的路径。增加 `restoreFunctionalModule()` 或等价的原子 active 文件更新能力，恢复时只能指向已完成的版本目录。

- [ ] **Step 4: Implement the shared COS manager**

把 `functional-module-manager.ts` 改为以下边界：

```ts
export interface FunctionalModuleManagerOptions {
  rootDir?: string
  manifestUrl?: string
  platform?: FunctionalModulePlatform
  arch?: FunctionalModuleArchitecture
  clientVersion?: string
  fetchImpl?: FunctionalModuleFetch
  onProgress?: (payload: FunctionalModuleProgressPayload) => void
}

export async function fetchFunctionalModuleManifest(
  options?: FunctionalModuleManagerOptions,
): Promise<FunctionalModuleArtifact[]>

export async function installFunctionalModule(
  input: FunctionalModuleInstallInput,
  options?: FunctionalModuleManagerOptions,
): Promise<FunctionalModuleStatus>
```

`fetchFunctionalModuleManifest()` 通过 `COPIS_FUNCTIONAL_MODULE_MANIFEST_URL` 或显式 `manifestUrl` 获取 JSON，使用 `parseFunctionalModuleManifest()` 解析当前平台；不再请求 GitHub、OfficeCLI mirror 或读取 `releases/latest`。`getFunctionalModuleStatuses()` 固定注册 `officecli` 和 `rust-http-api`，required 值来自 manifest，manifest 不可用时使用本地 active 记录和模块注册表默认值。

下载逻辑使用 `response.body.getReader()` 写入 `<sha256>.partial`，检查 `content-length`（若存在）与 manifest `size`，计算 SHA256 后 rename；所有网络和磁盘错误映射为中文 `FunctionalModuleStatus.error` 或带 cause 的安装异常。OfficeCLI 与 Rust API 使用相同的 `installFunctionalModule()`，只由 module name 区分。

- [ ] **Step 5: Run focused tests and package typecheck**

```bash
bun test apps/electron/src/main/lib/functional-module-store.test.ts
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
bun run --filter='@copis/electron' typecheck
```

Expected: COS fixture tests pass, old GitHub URLs no longer 出现在 manager runtime path，Electron 包类型检查通过。

- [ ] **Step 6: Increment the Electron package patch version**

将当前 `@copis/electron` patch 版本递增 1，并同步现有 workspace/package metadata；不修改其他包版本。

- [ ] **Step 7: Commit the generic module manager change**

```bash
git add apps/electron/src/main/lib/functional-module-store.ts apps/electron/src/main/lib/functional-module-store.test.ts apps/electron/src/main/lib/functional-module-manager.ts apps/electron/src/main/lib/functional-module-manager.test.ts apps/electron/package.json bun.lock
git diff --cached --check
git commit -m "feat: manage functional modules from COS manifest"
```

## Task 3: Rust API active process、候选健康检查和回滚

**Files:**
- Modify: `apps/electron/src/main/lib/http-api-server.ts`
- Create: `apps/electron/src/main/lib/http-api-server-runtime.test.ts`
- Modify: `apps/electron/src/main/lib/http-api-server.test.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/lib/functional-module-manager.ts`（仅添加 Rust active update 回调，不重复实现下载）

- [ ] **Step 1: Write failing process lifecycle tests**

通过可注入的 `spawnImpl`、`fetchImpl` 和 temporary module root 测试以下场景：

```text
Given active rust-http-api path exists
When startHttpApiServer
Then spawn receives active entrypoint and COPIS_HTTP_API_PORT=51730

Given candidate binary returns /api/health ok on 51731
When updateHttpApiServer
Then old process is stopped, active pointer changes, and new process starts on 51730

Given candidate health check fails
When updateHttpApiServer
Then candidate is killed, old process remains, and active pointer is unchanged

Given new process fails health on the formal port
When updateHttpApiServer
Then old active metadata is restored and old process is restarted
```

- [ ] **Step 2: Run the new lifecycle tests and verify failure**

```bash
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
```

Expected: FAIL because process injection, active module resolution and candidate update functions do not exist.

- [ ] **Step 3: Separate binary resolution from process lifecycle**

在 `http-api-server.ts` 中保留 `COPIS_HTTP_API_SERVER` 为最高优先级覆盖；正式路径改为 `getFunctionalModulePath('rust-http-api')`；开发环境才允许 `native/http-api-server/target/debug` 和 `target/release` 候选。删除 packaged 模式对 `process.resourcesPath/bin` Rust API 的隐式 fallback。

把 spawn、HTTP health probe 和 timer 抽象为本文件内部可替换依赖，生产默认使用 `spawn` 与 `fetch`，测试注入 fake child process；不把 Electron `BrowserWindow` 引入纯进程测试。

- [ ] **Step 4: Implement candidate update and rollback**

实现以下公共边界：

```ts
export async function ensureHttpApiServer(options?: HttpApiServerOptions): Promise<void>
export async function updateHttpApiServer(options?: HttpApiServerOptions): Promise<boolean>
export function startHttpApiServer(options?: HttpApiServerOptions): void
export function stopHttpApiServer(): Promise<void>
```

`ensureHttpApiServer()` 在有 active 版本时先启动当前版本，再后台检查 manifest；无 active 版本时安装 required Rust 模块后启动。`updateHttpApiServer()` 将 candidate 绑定到 `HTTP_API_PORT + 1`（冲突时使用未占用临时端口），注入 Pi worker 和 `COPIS_MEMORY_DIR`，在 5 秒内轮询 `GET /api/health`；候选失败只终止候选。候选通过后停止旧进程、写 active、正式端口启动并健康检查；正式启动失败时用 store 的 restore 能力恢复旧记录和旧进程。

每次进程退出、error、定时器和 readline listener 都必须清理；`before-quit` 继续等待/触发 `stopHttpApiServer()`，不会遗留候选进程。

- [ ] **Step 5: Wire startup without blocking the UI**

将 `bootstrap()` 中的 `safeRun('startHttpApiServer', startHttpApiServer)` 改为调用 `void safeAwait('ensureHttpApiServer', ensureHttpApiServer)` 或等价的隔离异步入口：有可用 active 版本立即启动；网络安装失败只记录错误并让窗口继续创建。保留 `COPIS_HTTP_API_PORT` 与 `COPIS_PI_RPC_WORKER` 的现有环境契约。

- [ ] **Step 6: Run process and existing HTTP facade tests**

```bash
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/main/lib/http-api-server.test.ts
bun run --filter='@copis/electron' build:main
```

Expected: lifecycle BDD、现有 Rust HTTP facade 测试和主进程 bundle 全部通过。

- [ ] **Step 7: Commit Rust API lifecycle change**

```bash
git add apps/electron/src/main/lib/http-api-server.ts apps/electron/src/main/lib/http-api-server-runtime.test.ts apps/electron/src/main/lib/http-api-server.test.ts apps/electron/src/main/index.ts
git diff --cached --check
git commit -m "feat: launch Rust API from active functional module"
```

## Task 4: IPC、Jotai 和设置页展示两个模块

**Files:**
- Modify: `apps/electron/src/renderer/atoms/functional-modules.ts`
- Modify: `apps/electron/src/renderer/components/settings/FunctionalModulesCard.tsx`
- Modify: `apps/electron/src/renderer/components/settings/FunctionalModulesCard.test.tsx`（若现有测试文件位置不同，沿当前组件测试约定新增）
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`

- [ ] **Step 1: Add failing renderer scenarios**

测试状态加载后同时显示 `OfficeCLI` 和 `Rust HTTP API`；Rust API 的 `required` 标记和缺失错误可见；对单个模块点击检查/安装只调用对应 name；进度 Map 不会把两个模块互相覆盖；关闭或卸载 UI 不留下 progress listener。

- [ ] **Step 2: Run renderer test and verify failure**

```bash
bun test apps/electron/src/renderer/components/settings/FunctionalModulesCard.test.tsx
```

Expected: FAIL because card currently只渲染 `officecli`。

- [ ] **Step 3: Generalize the Jotai atoms and card**

将模块定义集中为：

```ts
const FUNCTIONAL_MODULES: Array<{ name: FunctionalModuleName; displayName: string }> = [
  { name: 'rust-http-api', displayName: 'Rust HTTP API' },
  { name: 'officecli', displayName: 'OfficeCLI' },
]
```

状态以 `Record<FunctionalModuleName, FunctionalModuleStatus>` 保存，进度以同样 key 保存；card 以可读的模块列表渲染，复用现有 SettingsCard、Button 和 lucide icons。Rust API 的安装/更新按钮与 OfficeCLI 共用动作，但用户文案明确显示“由 Electron 管理”。错误文案只显示服务端提供的简洁中文信息。

- [ ] **Step 4: Keep IPC contract type-safe**

IPC handler 继续校验 name 为非空字符串并交给 manager 的 allowlist；preload 的三种调用和 progress listener 不新增远程文件路径或 URL 参数。必要时新增 `refreshFunctionalModules` 仅用于重新读取两个状态，不重复注册 IPC channel。

- [ ] **Step 5: Run focused renderer and type checks**

```bash
bun test apps/electron/src/renderer/components/settings/FunctionalModulesCard.test.tsx
bun run --filter='@copis/electron' build:renderer
bun run --filter='@copis/electron' typecheck
```

- [ ] **Step 6: Commit the user-facing module status change**

```bash
git add apps/electron/src/renderer/atoms/functional-modules.ts apps/electron/src/renderer/components/settings/FunctionalModulesCard.tsx apps/electron/src/renderer/components/settings/FunctionalModulesCard.test.tsx apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git diff --cached --check
git commit -m "feat: show all managed functional modules"
```

## Task 5: COS manifest 生成、二进制发布和正式打包边界

**Files:**
- Create: `apps/electron/scripts/build-functional-module-manifest.ts`
- Create: `apps/electron/scripts/publish-functional-modules.ts`
- Create: `apps/electron/src/main/lib/functional-module-publisher.ts`
- Create: `apps/electron/src/main/lib/functional-module-publisher.test.ts`
- Modify: `apps/electron/scripts/build-http-api-server.ts`
- Modify: `apps/electron/package.json`
- Modify: `apps/electron/electron-builder.yml`

- [ ] **Step 1: Verify COS publishing dependency before installation**

先执行：

```bash
bun pm view cos-nodejs-sdk-v5 version
bun pm view cos-nodejs-sdk-v5 dist-tags --json
```

查阅腾讯云 COS 官方 Node.js SDK 文档，确认当前版本支持 Bun 的 Node compatibility、`PutObject` 和 public/custom-domain URL。只有确认兼容后才在 `apps/electron/package.json` 加入精确版本并运行 `bun install`；不能把 COS secret 放入依赖配置或源码。

- [ ] **Step 2: Write failing publisher tests**

用 temporary fixture 生成一个 OfficeCLI 文件和一个 Rust API 文件，测试 `buildFunctionalModuleManifest()` 输出：平台 key 正确、size/SHA256 正确、URL 使用 immutable version name、两个模块都写入 required 值。测试缺文件、非法版本和重复 module name 时拒绝。

- [ ] **Step 3: Run publisher tests and verify failure**

```bash
bun test apps/electron/src/main/lib/functional-module-publisher.test.ts
```

Expected: FAIL because publisher module does not exist。

- [ ] **Step 4: Implement manifest builder and COS uploader**

`functional-module-publisher.ts` 只接受显式的 `{ module, version, platform, arch, binaryPath, publicBaseUrl, required }` 输入，返回可序列化 manifest 和 upload entries；使用 `createHash('sha256')` 与 `stat` 计算 metadata。上传器按以下顺序调用 COS client：

```ts
await uploadImmutableBinary(binary)
await verifyRemoteObject(binary.key, binary.sha256, binary.size)
await uploadManifest(manifest)
await verifyRemoteObject(manifest.key, manifest.sha256, manifest.size)
```

脚本参数来自命令行和环境变量：`COS_BUCKET_URL`、`COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_PREFIX`、`COS_PUBLIC_BASE_URL`；任何 secret 只传给 SDK，不打印。manifest 上传失败时不删除已有对象。

- [ ] **Step 5: Make build output development-only**

修改 `build-http-api-server.ts` 保留 Cargo release 编译，但默认只确保 `native/http-api-server/target/release` 可用，不复制 Rust API 到 `resources/bin`；提供显式 `COPIS_BUILD_BUNDLED_HTTP_API=1` 才复制兼容产物。正式 `http-api-server.ts` 不读取 packaged `resourcesPath/bin` Rust API；`electron-builder.yml` 的 `resources/bin` 保留 Copis CLI，同时过滤 Rust API 文件，避免旧生成文件被重新打包。

- [ ] **Step 6: Add scripts and version metadata**

在 `apps/electron/package.json` 增加：

```json
"build:functional-module-manifest": "bun run scripts/build-functional-module-manifest.ts",
"publish:functional-modules": "bun run scripts/publish-functional-modules.ts"
```

递增受影响 Electron patch 版本（若 Task 2 已递增则只递增一次），同步 lockfile。发布工具不能接入应用启动 bundle，只在 script 入口运行。

- [ ] **Step 7: Run publisher/build checks**

```bash
bun test apps/electron/src/main/lib/functional-module-publisher.test.ts
bun run --filter='@copis/electron' build:http-api-server
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
```

- [ ] **Step 8: Commit the COS publishing and packaging boundary**

```bash
git add apps/electron/scripts/build-functional-module-manifest.ts apps/electron/scripts/publish-functional-modules.ts apps/electron/src/main/lib/functional-module-publisher.ts apps/electron/src/main/lib/functional-module-publisher.test.ts apps/electron/scripts/build-http-api-server.ts apps/electron/package.json apps/electron/electron-builder.yml bun.lock
git diff --cached --check
git commit -m "feat: add COS functional module publishing"
```

## Task 6: 集成验证和交付检查

**Files:**
- Modify only tests or implementation files needed by failures found in Tasks 1-5.
- Do not modify `AGENTS.md` or `README.md` without a separate user instruction.

- [ ] **Step 1: Run the complete focused BDD set**

```bash
bun test apps/electron/src/main/lib/functional-module-manifest.test.ts
bun test apps/electron/src/main/lib/functional-module-store.test.ts
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/main/lib/http-api-server.test.ts
bun test apps/electron/src/main/lib/functional-module-publisher.test.ts
bun test apps/electron/src/renderer/components/settings/FunctionalModulesCard.test.tsx
```

网页或 Electron 相关 mock 测试保持单独 Bun 进程运行，不把多个 `mock.module('./config-paths')` 测试合并到同一进程。

- [ ] **Step 2: Run package validation**

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
bun run --filter='@copis/electron' build:http-api-server
git diff --check
```

- [ ] **Step 3: Run a real local lifecycle smoke**

用临时 `COPIS_FUNCTIONAL_MODULE_MANIFEST_URL` 指向本地 fixture，启动 Electron，确认：

1. 已激活 Rust API 从 `~/.copis/modules/versions/rust-http-api/...` 启动。
2. TCP `51730` 由 Electron 启动的 active Rust 进程监听。
3. `GET http://127.0.0.1:51730/api/health` 返回 `ok: true`。
4. 设置页同时出现 Rust HTTP API 与 OfficeCLI。
5. fixture 提供坏 SHA256 时旧版本仍可用，partial/候选进程退出。

- [ ] **Step 4: Review final diff and status**

```bash
git diff --stat HEAD~5..HEAD
git status --short --branch
git log --oneline -6
```

确认只提交了本功能的文件，前序 dirty 文件仍保持原状态；最终报告测试结果、构建结果、未验证的真实 COS 上传条件和剩余风险。
