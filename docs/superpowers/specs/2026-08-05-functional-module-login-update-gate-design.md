# Copis 登录后功能模块更新 Gate 设计

## 状态

- 日期：2026-08-05
- 状态：已确认设计，待实现
- 关联设计：`2026-08-05-copis-cos-functional-modules-design.md`

本文档补充并覆盖关联设计中的启动更新流程。自本设计起，`officecli` 与
`rust-http-api` 都是必选模块；两个模块完成安装、更新和校验，且正式端口上的
Rust HTTP API 通过 health 检查后，Copis 才能进入 onboarding 或主界面。

## 目标

用户登录成功后，Copis 自动检查当前平台的全部必选功能模块。缺失或存在更新的
模块由 Electron 自动下载、校验和激活，Renderer 使用符合 Copis 主题的全屏页面
展示状态、当前模块和进度。模块处理最多占总进度的 95%，最后 5% 固定用于启动
Rust HTTP API 并确认正式 API 已健康。

## 核心决策

- 更新 Gate 位于 `App.tsx` 的登录态之后、onboarding 和主界面之前。
- 主界面、Agent、工作区和其他全局业务组件在 Gate 完成前不挂载。
- Electron 主进程负责模块编排、Rust 进程切换和 health；Renderer 不直接探测端口。
- `officecli` 和 `rust-http-api` 都是必选模块，任一模块失败都阻止进入主界面。
- 模块安装串行执行，避免下载目录、active 指针和 Rust 进程生命周期互相竞争。
- 模块处理进度封顶为 `0.95`；正式 API health 从 `0.95` 推进到 `1.0`。
- 错误页只提供重试，不提供跳过或继续进入应用。

## 范围

### 包含

- 新增登录后全屏功能模块更新 Gate。
- 新增 Electron 统一“确保必选模块就绪”编排入口和对应 IPC。
- 新增独立的启动聚合进度事件，不改变现有单模块进度事件的含义。
- 自动检查、安装和更新 OfficeCLI 与 Rust HTTP API。
- Rust 候选端口检查、正式端口切换、health 轮询和失败回滚。
- Rust 重启成功后重新同步当前 Working 登录 token。
- 设置页继续复用同一份 Jotai 模块状态和单模块进度。
- BDD 单元测试、主进程测试、Renderer 构建和真实 Electron 页面验证。

### 不包含

- 不新增跳过必选模块的设置。
- 不改变 COS manifest 的平台、架构、SHA256 或不可变对象规则。
- 不让 Skill、Renderer 或 Rust API 自行管理模块版本。
- 不并行下载多个必选模块。
- 不修改应用自动更新 Electron 安装包的现有流程。

## 登录与放行流程

```text
读取登录态
  -> 未登录：显示登录页
  -> 已登录：挂载 FunctionalModuleUpdateGate
      -> 获取 manifest 和本地状态
      -> 安装/更新 OfficeCLI
      -> 准备 Rust HTTP API 候选版本
      -> 候选端口 health
      -> 激活 Rust 版本并切换正式端口
      -> 正式端口 /api/health
      -> 同步 Working token
      -> 全部就绪：进入 onboarding 或主界面
```

应用启动阶段仍可启动已有 active 或随应用提供的 Rust API，以支持登录与本地 HTTP
兼容层，但不再在后台发起模块更新。登录后的 Gate 是唯一自动检查和更新入口，避免
启动阶段后台更新与可视化更新重复执行。

## Electron 编排

新增主进程服务函数 `ensureRequiredFunctionalModules()`。同一用户数据目录只保留一个
活跃 Promise；React Strict Mode 重挂载、重复 IPC 或设置页操作不能启动第二条自动
更新链路。

编排步骤：

1. 获取并解析一次当前平台 manifest。
2. 校验 manifest 中所有必选模块都存在，且 OfficeCLI、Rust API 均为 `required: true`。
3. 读取两个模块的 active 状态，按 `version + sha256` 判断是否需要更新。
4. OfficeCLI 需要更新时，沿用功能模块 manager 的下载、SHA256 校验、缓存、组装和
   active 原子切换。
5. Rust API 需要更新时，沿用 `updateHttpApiServer()` 的候选端口、安全切换和回滚。
6. Rust 无需更新时，确保正式进程已启动。
7. 模块阶段完成后发送 `progress: 0.95`，开始正式端口 health。
8. health 成功后重新同步当前 Working token，发送 `progress: 1` 并返回最终模块状态。

Rust 更新过程必须把 manager 的单模块进度继续发送给现有
`functional-module:progress` 订阅者。候选版本或正式版本 health 失败时，恢复旧 active
记录和旧进程；自动更新 Gate 保持错误状态，不放行主界面。

## Health 契约

health 请求由 Electron 主进程访问正式地址：

```text
GET http://127.0.0.1:<COPIS_HTTP_API_PORT>/api/health
```

成功条件同时包含：

- HTTP 状态为 2xx。
- JSON 的 `ok` 为 `true`。
- `service` 为 `copis-http-api`，避免端口被其他进程占用时误判健康。

沿用当前 100ms 轮询间隔和默认 5 秒超时。轮询期间聚合进度位于 95% 至 99%；只有
满足完整 health 契约后才发送 100%。超时、连接失败、非 2xx、无效 JSON 或服务标识
不匹配都视为失败。

## 进度模型

现有 `FunctionalModuleProgressPayload` 继续表示单个模块内部的 manifest、download、
verify、install、activate、done 和 error，不改变其 `progress` 语义。

新增启动聚合进度契约：

```ts
interface FunctionalModuleStartupProgressPayload {
  phase: 'checking' | 'modules' | 'health' | 'ready' | 'error'
  detail: string
  progress: number
  activeModule?: FunctionalModuleName
  downloadedBytes?: number
  totalBytes?: number
  error?: string
}
```

聚合规则：

- `0% - 5%`：读取本地状态、下载并解析 manifest。
- `5% - 95%`：处理全部必选模块。
- `95% - 100%`：启动并检查正式 Rust HTTP API。

模块阶段按 manifest 声明的文件大小分配权重。无需下载或命中已校验缓存的模块可以
直接完成自己的区间，但整体进度不能回退。模块进度事件中的下载字节数映射为当前
模块区间的实时进度；校验、安装和激活占该模块区间的尾部。最后一个模块完成时只能
到达 95%。

## Renderer 与 Jotai

新增 `FunctionalModuleUpdateGate`，在登录成功后调用统一 IPC，并订阅启动聚合进度。
Gate 将最终状态写入现有：

- `functionalModuleStatusesAtom`
- `functionalModuleProgressAtom`
- `functionalModuleBusyAtom`

新增一个启动 Gate atom 保存 `checking/updating/health/ready/error`、聚合进度和错误。
设置页 `FunctionalModulesCard` 继续展示单模块状态；进入主界面后打开设置页时不重复
启动自动更新。

新的 preload API 包含：

- `ensureRequiredFunctionalModules()`：执行或复用统一更新 Promise，返回最终状态列表。
- `onFunctionalModuleStartupProgress(callback)`：订阅登录后启动聚合进度。

IPC 校验、业务编排、Preload 类型和 Renderer 调用按共享类型 -> 主进程 -> Preload ->
Renderer 的现有四层模式同步修改。

## 页面设计

更新页使用 Copis 现有主题变量，不复制 `ai-education` 的绿色品牌色或轨道动画：

- 全屏背景使用 `bg-background`，保留 Electron 顶部拖拽区域。
- 主体为居中的非卡片式窄布局，使用 Copis Logo、紧凑标题、状态文案和数字进度。
- 主进度条使用 `bg-secondary` 轨道和 `bg-primary` 填充，宽度稳定且不随文案变化。
- Rust API 与 OfficeCLI 各占一行，显示等待、检查、下载、校验、激活和已就绪状态。
- 下载阶段显示 `已下载 / 总大小`，数字使用等宽数字样式。
- 95% 后明确显示“正在检查本地 API”，避免用户误以为下载停滞。
- 完成后短暂显示“所有模块已就绪”，随后自动进入 onboarding 或主界面。
- 错误状态使用 destructive 主题色，显示简洁中文错误和“重试更新”按钮。

页面使用现有 Tailwind 主题 token 和 Lucide 图标，兼容浅色、深色和项目已有主题；不
引入独立固定色板、装饰渐变、嵌套卡片或大面积营销式标题。

## 错误与恢复

- manifest 缺失必选模块：阻断并提示模块清单不完整。
- 网络、大小或 SHA256 失败：清理 partial，保留旧 active 版本，允许重试。
- OfficeCLI 激活失败：保留旧版本并阻断。
- Rust 候选 health 失败：停止候选，保留当前正式进程并阻断。
- Rust 正式 health 失败：恢复旧 active 与旧进程并阻断。
- 当前进程 health 失败：重新启动一次当前 active 版本；仍失败则阻断。
- 重试复用缓存中已通过 SHA256 校验的对象，不重复下载完整文件。

错误文案不显示 COS secret、内部 token、堆栈或用户不可操作的内部路径。

## BDD 验收场景

```text
Given 用户已登录且两个必选模块都是最新版本
When Copis 执行登录后模块检查
Then 进度完成模块检查后到达 95%
And 正式 Rust API health 成功后到达 100% 并进入主界面

Given OfficeCLI 缺失或不是最新版本
When Copis 执行登录后模块检查
Then Electron 自动下载、校验并激活 OfficeCLI
And OfficeCLI 未就绪前不会进入主界面

Given Rust API 有新版本
When Electron 更新 Rust API
Then 候选端口 health 成功后才切换 active 和正式端口
And 正式端口 health 成功前聚合进度不会超过 99%

Given 正式端口返回其他服务的 2xx 响应
When Electron 检查 /api/health
Then 因 service 不是 copis-http-api 而判定失败
And 更新页保持错误状态

Given 任一必选模块下载或 health 失败
When 用户看到更新错误页
Then 主界面尚未挂载且只能选择重试更新

Given React Strict Mode 重挂载更新 Gate
When ensureRequiredFunctionalModules 被重复调用
Then Electron 复用同一个活跃更新 Promise，不重复下载或切换进程
```

## 验证

实现阶段至少执行：

```bash
bun test apps/electron/src/main/lib/functional-module-startup.test.ts
bun test apps/electron/src/main/lib/functional-module-manager.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/renderer/components/functional-modules/functional-module-startup-ui.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
```

真实验证必须在 Electron 主窗口完成：登录后确认更新页先于 onboarding/主界面出现，
模块阶段封顶 95%，health 阶段从 95% 到 100%，失败时不能进入主界面。浅色和深色
主题都要检查文案、进度条、模块状态、错误按钮和窗口尺寸，不以普通浏览器中的
`about:blank` 或静态 DOM 代替 Electron 进程切换与 health 验证。
