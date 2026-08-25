# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

**重要提示：**
- 当功能发生变化时，请保持此文件和 `README.md` 同步更新。请更新文档以反映当前状态，但是需要经过我的允许后再修改。
- 所有的注释和日志优先采用中文，保留必要的专业术语部分。
- 所有的依赖包的安装都要先进行搜索，综合判断依赖采用的版本，而不是默认采用某个版本。
- 状态管理上我们全部采用 Jotai 来实现。
- 这是个开源项目，本地存储优先，善用配置文件优于大部分默认采用 localstorage，不采用本地数据库方案。
- 保证充分的组件化以及人类的可读性，每次完成改动后都要思考这一点，运行@code-simplifier 来简化优化代码，保持简单直接不过渡设计的风格。
- 在 UI 设计上采用更现代的方案，UI 组件推荐采用 ShadcnUI，在合适的情况下，用卡片和阴影取代边框，用符合主题的饱满色彩，设置界面要设置背景，为未来做不同主题留下空间。
- Electron UI 层功能的真实交互、视觉效果与最终验收必须由用户在实际应用窗口中确认。Agent 不得使用截图、截图比对或截图分析代替用户确认；Agent 可执行代码检查、自动化测试、类型检查、构建、日志和运行状态验证，并在交付时明确标注仍需用户确认的 UI 项目。
- 采用 BDD 行为驱动开发的方案。

## 项目概述

Copis 是一个集成通用 AI Agent 的下一代人工智能软件，采用 Electron 桌面应用架构。

## Monorepo 结构

Bun workspace monorepo：

```
copis-v2/
├── packages/
│   ├── shared/     # 共享类型、IPC 通道常量、配置、工具函数 (v0.1.63)
│   ├── core/       # AI Provider 适配器、代码高亮服务 (v0.2.18)
│   └── ui/         # 共享 UI 组件 (CodeBlock, MermaidBlock) (v0.1.10)
└── apps/
    └── electron/   # Electron 桌面应用 (v0.0.39)
        └── src/
            ├── main/       # 主进程 + 服务层 (main/lib/)
            ├── preload/    # IPC 上下文桥接
            └── renderer/   # React UI (Vite + Tailwind + Radix UI)
```

**包命名规范**：`@copis/*` 作用域（`@copis/core`、`@copis/shared`、`@copis/ui`、`@copis/electron`）

**依赖管理**：package.json 中使用 `workspace:*` 引用内部包

### 包职责详解

#### @copis/shared (v0.1.63)
- **导出模块**：`./types`、`./config`、`./utils`、`./constants/permission-rules`
- **关键类型**：`AgentMessage`、`ChatMessage`、`Channel`、`PermissionRequest`、`FeishuConfig`
- **依赖**：无运行时依赖（仅 TypeScript）

#### @copis/core (v0.2.18)
- **导出模块**：`./providers`、`./highlight`、`./types`、`./utils`
- **关键功能**：Provider 适配器注册表、代码高亮（Shiki）
- **依赖**：`@copis/shared`、`shiki`
- **Peer 依赖**：`@anthropic-ai/sdk`、`@modelcontextprotocol/sdk`

#### @copis/ui (v0.1.10)
- **关键组件**：共享 React UI 组件库
- **依赖**：`@copis/core`、`beautiful-mermaid`、`mermaid`、`shiki`
- **Peer 依赖**：`react@^18.3.0`、`react-dom@^18.3.0`

#### @copis/electron (v0.0.39)
- **职责**：Electron 桌面应用主体，集成所有包
- **关键依赖**：
  - `@earendil-works/pi-coding-agent@0.82.1`、`pi-agent-core@0.82.1`、`pi-ai@0.82.1` - Pi Agent runtime
  - `pi-web-access@0.18.0` - 默认内置的 Pi 扩展（联网搜索、网页抓取、来源核查）
  - `@larksuiteoapi/node-sdk` - 飞书集成
  - Radix UI、TipTap、Tailwind CSS
  - 文件解析：`pdf-parse`、`officeparser`、`word-extractor`

## 常用命令

```bash
# 开发模式（推荐 - 自动启动 Vite + Electron + 热重载）
bun run dev

# 手动开发模式（调试时更稳定）
# 终端 1: cd apps/electron && bun run dev:vite
# 终端 2: cd apps/electron && bun run dev:electron

# 构建并运行
bun run electron:start

# 仅构建
bun run electron:build

# 类型检查（所有包）
bun run typecheck

# 单包类型检查
cd packages/core && bun run typecheck

# 测试
bun test

# 打包分发
cd apps/electron
bun run dist:mac      # macOS
bun run dist:win      # Windows
bun run dist:linux    # Linux
bun run dist:fast     # 当前架构快速打包
```

Pi Worker 的自包含运行时由应用构建链生成，不需要在开发环境预先生成：

```bash
cd apps/electron
bun run build:cli     # Bun build --compile，生成当前平台/架构的 copis(.exe)
bun run build:node-runtime-module # 打包用户工作区项目使用的 Node.js + npm runtime
```

### 仓库级构建与部署

```powershell
# Windows：默认只构建 Electron 应用，不编译 Rust API、不发布 COS
powershell -ExecutionPolicy Bypass -File .\build.ps1

# Windows：默认构建 Rust API、生成功能模块 manifest 并发布 COS
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -Platform win32 -Arch x64

# Windows：部署功能模块时同时构建 Electron 安装包
powershell -ExecutionPolicy Bypass -File .\deploy.ps1 -BuildApp -Platform win32 -Arch x64
```

```bash
# macOS：默认只构建 Electron DMG，不编译 Rust API、不发布 COS
bash ./build.sh

# macOS/Linux：默认构建当前平台 Rust API、生成 manifest 并发布 COS
./deploy.sh --platform darwin --arch arm64
./deploy.sh --platform linux --arch x64

# 部署功能模块时同时构建当前平台 Electron 包
./deploy.sh --build-app
```

构建与部署边界必须保持以下规则：

- `build.ps1`、`build.sh` 和 `apps/electron` 的默认 `build` 只负责 Electron 应用，不调用 `build:http-api-server`，也不执行 COS 发布。
- `deploy.ps1`、`deploy.sh` 默认负责 Rust API 二进制、功能模块 manifest 和 COS 发布；Electron 应用包只有传入 `-BuildApp` 或 `--build-app` 时才构建。
- 发布前需要通过 `.env` 或参数提供 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET_URL`、`COS_PUBLIC_BASE_URL`；禁止把密钥写入 manifest、日志或构建产物。
- `deploy.ps1` 适用于 Windows x64 Rust 构建；跨平台部署应在目标平台执行对应的 `deploy.sh`，或使用 `-SkipRustBuild` / `--skip-rust-build` 配合已经验证的目标二进制。
- 功能模块发布包含 `node-runtime`、`rust-http-api` 和可选的 `officecli`。`node-runtime` 是按目标平台和架构打包的 Node.js + npm `tar.gz` 归档，终端用户无需自行安装 Node.js 或 npm；OfficeCLI 是外部单文件二进制，需要通过 `COPIS_OFFICECLI_BINARY` 或 `apps/electron/resources/bin/officecli.exe` 提供，并通过 `COPIS_OFFICECLI_VERSION` 指定独立于 Electron 的模块版本。
- `deploy.ps1` / `deploy.sh` 默认会构建并发布 Node runtime；单模块发布可使用 `-NodeRuntimeOnly` / `--node-runtime`，已有归档可通过 `-NodeRuntimeArchive` / `--node-runtime-archive` 提供，模块版本可通过 `-NodeRuntimeVersion` / `--node-runtime-version` 指定。单模块发布会校验同一平台和架构的其他必要模块仍存在于远端 manifest。
- 发布单个平台时必须合并 COS 中已有 manifest，保留其他平台和模块；二进制对象使用不可变版本 key，只有 manifest 允许更新。
- `build.ps1` 和 `bun run --filter='@copis/electron' dist:win` 会在 Windows x64 构建中执行 `build:cli`；macOS ARM/Intel 需在对应 runner 上执行 `build.sh` 或 `dist:mac`，不能用其他平台的 `copis` 产物代替。
- `--rust` / `--officecli` / `--node-runtime` 是功能模块的单模块 COS 发布选项；它们与应用内的 `copis` 组合运行时构建无关，不能用功能模块二进制替代组合运行时。

常用部署选项：`-SkipInstall` / `--skip-install`、`-SkipRustBuild` / `--skip-rust-build`、`-SkipPublish` / `--skip-publish`、版本、平台、架构、channel、COS 前缀和已有 Rust 二进制路径。当前 stable 的 Windows x64 OfficeCLI 模块版本为 `1.0.143`。

### Electron 构建脚本（`apps/electron/` 目录下）

```bash
bun run build:main        # esbuild → dist/main.cjs
bun run build:preload     # esbuild → dist/preload.cjs
bun run build:renderer    # Vite → dist/renderer/
bun run build:resources   # 复制 resources/ 到 dist/
bun run generate:icons    # 生成应用图标
bun run build:cli         # Bun build --compile → resources/bin/{platform}-{arch}/copis(.exe)
bun run copy:pi-extensions # 复制默认 Pi 扩展及依赖闭包 → resources/pi-extensions/（build 链自动执行）
bun run build:http-api-server # 显式构建 Rust HTTP API 功能模块
bun run build:node-runtime-module # 将当前平台 Node.js + npm 打包为功能模块归档
```

## 运行时环境

仓库自身使用 Bun；工作区中的用户项目使用 Copis 随功能模块提供的 Node.js + npm：

- `bun install` 安装依赖，`bun run <script>` 运行脚本
- `bun test` 运行测试（内置测试运行器，`import { test, expect } from "bun:test"`）
- Bun 自动加载 .env 文件（无需 dotenv）
- 优先使用 Bun 原生 API：`Bun.file` > `node:fs`，`Bun.$\`command\`` > `execa`
- Agent 创建的前端项目必须使用 Vue 3 + Vite；项目依赖安装和 `npm run dev` 由 Rust HTTP API 调用内置 Node/npm 完成，用户不需要在系统中安装 Node.js。
- 每个工作区项目都位于工作区 `project/` 目录下，启动时由 Rust API 分配并持久化独立的 Vite 端口，随后由内置浏览器打开项目地址。

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **运行时** | Bun | 1.2.5+ |
| **语言** | TypeScript | 5.0.0+ |
| **桌面框架** | Electron | 43.2.0 |
| **前端框架** | React | 18.3.1 |
| **状态管理** | Jotai | 2.17.1 |
| **UI 组件** | Radix UI | 最新 |
| **样式** | Tailwind CSS | 3.4.17 |
| **富文本编辑器** | TipTap | 3.19.0 |
| **代码高亮** | Shiki | 3.22.0 |
| **Markdown** | React Markdown | 10.1.0 |
| **图表** | Beautiful Mermaid | 最新 |
| **数学公式** | KaTeX | 0.16+ |
| **构建工具** | Vite | 6.0.3 |
| **打包工具** | esbuild | 0.24.0+ |
| **分发工具** | Electron Builder | 25.1.8 |
| **Pi Agent SDK** | `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` | 0.82.1 |
| **飞书 SDK** | @larksuiteoapi/node-sdk | 最新 |

## 核心架构

### IPC 通信模式（最重要的架构模式）

类型定义 → 主进程处理 → Preload 桥接 → 渲染进程调用：

1. **类型 & 常量**：`@copis/shared` 定义 IPC 通道名称常量和请求/响应类型
2. **主进程处理**：`main/ipc.ts`（57KB）注册 `ipcMain.handle()` 处理器，调用 `main/lib/` 服务
3. **Preload 桥接**：`preload/index.ts` 通过 `contextBridge.exposeInMainWorld` 暴露类型安全的 API
4. **渲染进程**：通过 `window.electronAPI.*` 调用，Jotai atoms 中封装调用逻辑

添加新 IPC 通道时，需要同步修改这四个位置。

#### 主要 IPC 通道组

- `IPC_CHANNELS` - 基础通道（运行时、Git、环境）
- `CHANNEL_IPC_CHANNELS` - 渠道管理
- `CHAT_IPC_CHANNELS` - Chat 功能
- `AGENT_IPC_CHANNELS` - Agent 功能
- `ENVIRONMENT_IPC_CHANNELS` - 环境检查
- `PROXY_IPC_CHANNELS` - 代理设置
- `SYSTEM_PROMPT_IPC_CHANNELS` - 系统提示词
- `CHAT_TOOL_IPC_CHANNELS` - Chat 工具
- `FEISHU_IPC_CHANNELS` - 飞书集成与 Hermes 扫码注册
- `WECHAT_IPC_CHANNELS` - 微信 iLink Bot 扫码登录与长连接
- `DINGTALK_IPC_CHANNELS` - 钉钉 Stream 直连与 OAuth 扫码授权

### 主进程服务层（`main/lib/`）

#### 核心服务

| 服务 | 职责 |
|------|------|
| `agent-orchestrator.ts` | Agent 核心编排层：并发守卫、渠道查找、Pi runtime 环境构建、消息持久化、事件流处理、错误处理、自动标题生成（支持剥除飞书/微信/钉钉桥接信封提取真实用户消息） |
| `agent-session-manager.ts` | Agent 会话管理：SDK 消息持久化、会话元数据 CRUD、JSONL 存储、飞书/微信/钉钉专属会话管理与模型继承 |
| `agent-prompt-builder.ts` | Agent 系统提示词构建（18KB）：动态上下文构建、内置 Agent 构建、工作区上下文注入 |
| `agent-permission-service.ts` | Agent 权限管理：工具权限检查、权限模式管理 |
| `agent-ask-user-service.ts` | Agent 用户交互：AskUser 请求处理 |
| `agent-exit-plan-service.ts` | Agent 退出计划服务 |
| `agent-workspace-manager.ts` | 工作区管理（16KB）：MCP Server 配置、Skills 配置、工作区 CRUD |
| `chat-service.ts` | Chat 流式调用编排（20KB）：Provider 适配器集成、消息持久化、AbortController |
| `conversation-manager.ts` | 对话管理（13KB）：对话 CRUD、JSONL 消息存储、置顶、上下文分割 |
| `channel-manager.ts` | 渠道管理（16KB）：渠道 CRUD、API Key AES-256-GCM 加密（safeStorage）、连接测试、模型获取 |

#### 集成服务与远程机器人

| 服务 | 职责 |
|------|------|
| `feishu-bridge.ts` | 飞书集成：Hermes 一键扫码注册、消息双向同步、任务通知 |
| `wechat-bridge.ts` | 微信集成：腾讯 iLink Bot 官方扫码登录、长连接监听与消息分发 |
| `dingtalk-bridge-manager.ts` | 钉钉多 Bot 桥接：Stream 模式 WebSocket 直连、免公网服务器收发消息 |
| `dingtalk-oauth-service.ts` | 钉钉 OAuth 2.0 授权：Code 交换与账号绑定 |
| `bridge-command-handler.ts` | 统一桥接命令路由：专属会话维护、权限交互指令、消息格式标准化 |

#### 工具与文件

| 服务 | 职责 |
|------|------|
| `chat-tools/` | Chat 工具实现目录：内置工具函数 |
| `workspace-watcher.ts` | 项目根目录、会话文件与附加目录监听：文件系统变化监控 |
| `chat-tools-watcher.ts` | Chat 工具监听：工具配置变化监控 |
| `attachment-service.ts` | 附件管理：存储/读取/删除、文件对话框 |
| `document-parser.ts` | 文档解析：PDF/Office/文本文件提取 |

#### 系统服务

| 服务 | 职责 |
|------|------|
| `runtime-init.ts` | 运行时初始化：Shell 环境、Bun、Git 检测（`bun-finder.ts`、`git-detector.ts`、`shell-env.ts`） |
| `config-paths.ts` | 配置路径管理：`~/.copis/` 目录结构 |
| `user-profile-service.ts` | 用户档案持久化 |
| `settings-service.ts` | 应用设置持久化（主题等） |
| `updater/` | 自动更新：Electron Updater 集成 |

### AI Provider 适配器（`packages/core/src/providers/`）

基于适配器模式的多 Provider 支持，通过注册表统一管理：

#### 核心架构
- `ProviderAdapter` 接口：定义统一的 `sendMessage()` 流式方法
- `provider-registry.ts`：Provider 注册表，按 `providerId` 查找适配器
- `sse-reader.ts`：通用 SSE 流读取器（fetch + ReadableStream）

#### 支持的 Provider

| Provider | 适配器 | API 协议 | 特性 |
|----------|--------|----------|------|
| **Anthropic** | `anthropic-adapter.ts` | Messages API | extended_thinking、多模态 |
| **OpenAI** | `openai-adapter.ts` | Chat Completions | 标准 OpenAI 协议 |
| **DeepSeek** | `anthropic-adapter.ts` | Messages API | Anthropic 兼容 |
| **智谱 AI** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **MiniMax** | `anthropic-adapter.ts` | Messages API | Anthropic 兼容 |
| **豆包** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **通义千问** | `openai-adapter.ts` | Chat Completions | OpenAI 兼容 |
| **Google** | `google-adapter.ts` | Generative Language API | Gemini 系列 |
| **Custom** | `openai-adapter.ts` | Chat Completions | 自定义 OpenAI 兼容端点 |

#### 多模态支持
- **图片**：各 Provider 格式不同，适配器自动转换
- **文档**：提取文本后注入 `<file>` XML 标签

### Jotai 状态管理（`renderer/atoms/`）

| Atom 文件 | 管理的状态 |
|-----------|-----------|
| `chat-atoms.ts` | 对话列表、当前消息、流式状态（Map 结构支持多对话并行）、模型选择、上下文设置、并排模式、思考模式、待上传附件 |
| `agent-atoms.ts` | Agent 会话列表、当前会话、流式状态（`AgentStreamState`）、工作区选择、渠道选择、权限/AskUser 请求队列（按 sessionId Map） |
| `active-view.ts` | 主面板视图切换（'conversations' / 'settings'） |
| `app-mode.ts` | 应用模式（Chat / Agent） |
| `settings-tab.ts` | 设置面板当前标签页 |
| `theme.ts` | 主题模式（light / dark / system） |
| `user-profile.ts` | 用户档案（姓名 + 头像） |
| `updater.ts` | 自动更新状态（检查/下载/安装），优雅降级（updater 不可用时保持 idle） |

### 渲染进程组件架构（`renderer/components/`）

- **`app-shell/`**：三面板布局（LeftSidebar | NavigatorPanel | MainContentPanel），侧边栏含模式切换、置顶对话、日期分组列表、流式指示器
- **`chat/`**：聊天核心 — ChatView（消息加载/流式订阅）、ChatHeader（模型选择/上下文设置）、ChatInput（Tiptap 富文本编辑器）、ChatMessages（消息列表/自动滚动）、ParallelChatMessages（并排模式）
- **`agent/`**：Agent 模式 — AgentView（纯展示 + 交互，IPC 监听已提升到全局）、AgentHeader（渠道/模型选择）、AgentMessages（消息列表 + 工具活动）、ToolActivityItem（工具调用展示）、WorkspaceSelector（工作区切换）、PermissionBanner/AskUserBanner（权限/问答请求 UI）
- **`settings/`**：设置面板 — GeneralSettings（用户档案）、AppearanceSettings（主题）、ChannelSettings（渠道管理）、ChannelForm（Provider 配置）、AgentSettings（Agent 渠道/工作区/MCP）、McpServerForm（MCP 服务器配置）、AboutSettings（版本/更新）、FeishuSettings（飞书集成）；含 `primitives/` 可复用表单组件
- **`file-browser/`**：文件浏览器 — FileBrowser（会话文件与项目根目录文件树浏览）
- **`ai-elements/`**：AI 展示组件 — Markdown 渲染、代码块、Mermaid 图、推理折叠、上下文分割线、富文本输入
- **`web-browser/`**：内嵌 Chromium 网页页签、浏览器工具栏、网页收藏夹与独立收藏夹浮层窗口
- **`ui/`**：Radix UI 组件（现代化设计，CSS 变量主题）

### 全局 Hooks（`renderer/hooks/`）

| Hook | 职责 |
|------|------|
| `useGlobalAgentListeners` | 全局 Agent IPC 监听器，在 `main.tsx` 顶层挂载，使用 `useStore()` 直接操作 atoms。处理流式事件、完成/错误、标题更新、权限请求、AskUser 请求，永不随组件卸载销毁 |
| `useBackgroundTasks` | 后台任务管理（Agent/Shell 任务的增删改查），按 sessionId 隔离 |

### 渲染进程初始化组件（`renderer/main.tsx`）

| 组件 | 职责 |
|------|------|
| `ThemeInitializer` | 从主进程加载主题设置、监听系统主题变化、同步到 DOM |
| `AgentSettingsInitializer` | 加载 Agent 渠道/模型/工作区设置、订阅 MCP/文件变化事件 |
| `AgentListenersInitializer` | 挂载 `useGlobalAgentListeners`，全局 Agent IPC 监听 |
| `UpdaterInitializer` | 订阅主进程推送的自动更新状态变化事件 |

### 原生网页页签与浮层窗口（必须遵守）

`main/lib/web-tab-manager.ts` 使用原生 `WebContentsView` 承载网页。原生子视图位于主渲染进程的 DOM 之上，CSS `z-index` 无法让普通 React/Radix 浮层覆盖网页；收藏夹因此使用以主窗口为 `parent` 的独立无边框 `BrowserWindow`，由 `WebBookmarksWindowApp` 单独渲染。

**实现约束：**

- 需要覆盖网页内容的菜单、抽屉或弹层，不能只挂在主窗口 DOM 中；应使用具有主窗口 `parent` 的原生子窗口（或同层级的原生 View），并保留失焦关闭和随主窗口移动/缩放的生命周期。不要默认使用全局 `alwaysOnTop`，避免浮层覆盖其他应用。
- 网页工具栏中的刷新、星标“收藏当前页”和列表“打开收藏夹”三个按钮不得挂载 hover Tooltip，也不显示 hover 背景或颜色变化；星标未收藏时保存当前网页，已收藏时直接取消收藏；列表按钮只负责打开原生收藏夹窗口。主窗口模式的 `WebBookmarksPopover` 必须保持关闭，禁止把收藏内容 Popover 重新挂回网页宿主。
- 独立窗口是新的 React 根节点，不会继承 `App.tsx` 中的 Context Provider。使用 Radix Tooltip 的独立入口必须显式包裹 `TooltipProvider`；`WebBookmarksWindowApp` 不得移除此 Provider，否则会抛出 `Tooltip must be used within TooltipProvider` 并留下空白窗口。新增 Dialog、Toast、主题等能力时也必须逐项检查其 Provider/Initializer。
- `PopoverContent` 带有 `zoom-in-95` 入场 transform。透明窗口自适应内容时，禁止用 `getBoundingClientRect().width/height` 驱动窗口尺寸，否则首帧会把 `384px` 误测为约 `365px`，动画结束后内容被裁切。应使用不受 transform 影响的 `offsetWidth/offsetHeight` 或 `ResizeObserverEntry.borderBoxSize`，主进程使用 `setContentBounds()` 同步内容区尺寸。
- 独立 Popover 的定位锚点必须保持零尺寸；`1px` 锚点会让面板从 `y=1` 开始并裁掉底边。触发按钮的屏幕位置仍可使用 `getBoundingClientRect()`，上述限制仅针对浮层内容宽高。
- 收藏夹独立窗口的 Popover 入场和退出动画使用 `duration-100` 并显式设置 `animationDuration: 100ms`，避免原生窗口显示与缩放/淡入动画叠加造成迟滞；不要通过修改全局 Popover 动画时长来解决。
- 收藏夹管理内容使用树形 UI：根节点为“全部收藏”，一级节点为现有平级分组和“未分组”，网页收藏作为分组子节点；展开状态只保存在渲染进程，持久化仍使用 `WebBookmark.groupId`，不得为了展示树形结构擅自改变存储模型。分组的重命名、删除和收藏移动操作必须从对应树节点继续可用。
- 原生网页页签的 `loadURL`、导航和 `did-fail-load` 回调可能在窗口/视图销毁后到达；所有异步状态刷新必须先检查 `record`、`view.webContents` 和 `isDestroyed()`，不能让释放竞态变成 `UnhandledPromiseRejection`。

**BDD 回归场景：**

```text
Given 顶部已打开并加载一个 HTTP(S) 网页页签
When 点击浏览器工具栏中的星标“收藏当前页”按钮
Then 未收藏时保存当前网页，已收藏时取消当前网页收藏，且不会在主窗口打开收藏内容抽屉

Given 顶部已打开并加载一个 HTTP(S) 网页页签
When 点击工具栏中的列表“打开收藏夹”按钮
Then 收藏夹完整显示在网页上方，内容不为空且可交互
And 独立窗口的 parent 是主窗口，失焦后正常关闭
And 控制台没有 Tooltip Provider 或 React 挂载错误
And 动画结束后 panel 的 right/bottom 不超过 window.innerWidth/innerHeight
```

修改该链路后至少执行：

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
bun test apps/electron/src/main/lib/web-bookmark-service.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
```

两个网页测试文件都会 mock `./config-paths`，必须分两个 Bun 进程运行，避免 module mock 互相覆盖产生假失败。完成自动化验证后，由用户在 Electron 实际窗口中打开普通网页并确认 UI 交互与视觉结果，不能只验证 `about:blank` 或主渲染进程 DOM；Agent 不得使用截图方案代替该用户确认。

### QM 风格结构化记忆系统（Memory System）

Copis 参考 YC QM 项目的结构化长期记忆管理思路（`notebook` / `capture` / `recall` / `read` / `rewrite` / `revision` 乐观锁 / `scope` 隔离 / `consolidation` 记忆整合 / `scratch` 临时记忆自动提炼），建立了本地化、受控且全自动的长期记忆系统。

#### 1. 核心架构与服务模块

- **存储底座与 API Gateway (`native/http-api-server/src/memory.rs`)**：
  - 本地 Rust HTTP API 服务（`127.0.0.1:51730/api/memory`）基于本地 SQLite 驱动；
  - 核心表结构包括 `memory_entries`、`memory_revisions`（全量变更历史与快照）与 `memory_maintenance_state`（维护状态）；
  - 支持 `revision` 乐观锁版本并发控制，确保 Agent 多任务并发写入时的数据一致性。
- **数据客户端运行时 (`apps/electron/src/main/lib/memory-api-client-runtime.ts`)**：
  - 主进程中对 Rust Memory HTTP API 的封装，支持按 scope、kind、tags 精确检索与批量原子操作。
- **上下文动态注入 (`apps/electron/src/main/lib/memory-context-builder.ts`)**：
  - 在 Agent 系统提示词构建时，根据当前会话内容与所属工作区，动态召回最相关的 Top-K 长期记忆并注入上下文。
- **Per-turn 自动感知与捕获 (`apps/electron/src/main/lib/adapters/pi-memory-auto-capture.ts`)**：
  - 对话流结束后，后台异步执行轻量抽取模型，自动从用户交互中提取偏好、项目事实与关键决策，无需用户手动保存。
- **智能维护与压缩整理 (`apps/electron/src/main/lib/adapters/pi-memory-organization.ts` / `pi-memory-maintenance.ts`)**：
  - 当上下文 Token 超过整理阈值（`PI_MEMORY_ORGANIZATION_THRESHOLD_TOKENS`）或触发维护周期时，排队执行记忆提炼（`promote`）、合并重写（`rewrite`）与旧记忆归档（`archive`），协助上下文压缩（Compaction）。

#### 2. 分级 Scope 与记忆分类

- **Scope 隔离**：
  - `user`：全局用户记忆（如用户编程偏好、语言习惯、个人通用配置）；
  - `workspace`：按工作区 `workspace_slug` 严格隔离的项目记忆，防止跨项目上下文污染。
- **记忆类型 (`kind`)**：
  - `fact`：客观事实与技术栈特性；
  - `preference`：用户个人偏好与编码规范；
  - `decision`：架构设计、技术选型与业务决策；
  - `project`：项目目录结构、构建方式与环境变量要求；
  - `scratch`：短期临时笔记与临时状态（14 天保留期，过期或自动提炼 promote 为长期事实）。

#### 3. Agent 记忆工具与策略权限 (`MemoryPolicy`)

- **策略权限**：
  - `visible`（只读检索）：仅暴露 `memory_recall`（关键词检索）、`memory_read`（精确读取）；
  - `writable`（读写管理）：暴露 `memory_recall`、`memory_read`、`memory_capture`（主动沉淀）、`memory_rewrite`（更新重写与归档）。
- **受控设计**：Agent 无法通过工具参数越权访问任意内部目录，记忆读写完全由当前会话的工作区边界约束。

### 本地文件存储（`~/.copis/`）

```
~/.copis/
├── channels.json           # 渠道配置（API Key 经 safeStorage 加密）
├── conversations.json      # 对话索引（元数据，轻量）
├── conversations/          # 消息存储
│   └── {uuid}.jsonl        # 每对话一个 JSONL 文件，追加写入
├── agent-sessions.json     # Agent 会话索引
├── agent-sessions/         # Agent 会话消息存储
│   └── {uuid}.jsonl        # 每会话一个 JSONL 文件
├── agent-workspaces/       # Agent 工作区目录
│   └── {workspace-slug}/
│       ├── {session-id}/   # 会话工作目录
│       ├── workspace-files/ # Copis 托管的工作区文件根
│       │   └── project/     # Agent 创建和运行的用户项目目录
│       ├── mcp.json        # MCP Server 配置
│       └── skills/         # Skills 配置目录
├── attachments/            # 附件文件
│   └── {conversationId}/
│       └── {uuid}.ext
├── user-profile.json       # 用户档案 { userName, avatar }
├── settings.json           # 应用设置 { themeMode }
└── sdk-config/             # Pi Agent session artifact 配置目录
    └── sessions/           # Pi session JSONL 文件
```

**关键设计**：
- JSON 配置 + JSONL 追加日志，无本地数据库，文件可移植
- Agent 工作区按 slug 隔离，每个会话独立目录
- 工作区项目统一放在 `project/`，项目目录默认允许 Agent 写入；项目开发服务由 Rust HTTP API 使用激活的 Node.js + npm runtime 启动
- MCP 配置和 Skills 按工作区管理

## 构建工具

- **主进程/Preload**：esbuild (`--bundle --platform=node --format=cjs --external:electron --external:@earendil-works/pi-coding-agent --external:@earendil-works/pi-agent-core --external:@earendil-works/pi-ai`)
- **渲染进程**：Vite + React 插件 + Tailwind CSS + HMR
- **开发热重载**：渲染进程 Vite HMR 即时生效；主进程/Preload 通过 electronmon 监听 dist 文件变化自动重启
- **打包分发**：electron-builder（配置见 `electron-builder.yml`）

### 重要：打包配置注意事项

**Pi Agent runtime 打包要求（必须遵守）：**
- `@earendil-works/pi-coding-agent`、`pi-agent-core` 和 `pi-ai` 必须使用 `--external` 参数排除在 esbuild 打包之外。
- `apps/electron/scripts/sync-runtime-deps.ts` 的 `EXTERNAL_RUNTIME_PACKAGES` 必须与 `build:main`、`build:agent-rpc-worker` 的 external 清单一致，并递归复制 Pi runtime 的依赖闭包。
- `pdfjs-dist`、`sharp` 及其运行时依赖也由同步脚本复制到 `apps/electron/node_modules/`。
- `electron-builder.yml` 使用 `files: node_modules/**/*` 包含同步后的 external 依赖，并排除 workspace 包和构建期依赖。
- `asarUnpack` 必须覆盖 Pi 的 native addon、`sharp`/`@img` 以及其他运行时要求文件；不要重新引入已移除的旧 runtime 平台 binary 规则。

**Pi Worker 自包含运行时要求（必须遵守）：**
- `apps/electron/scripts/build-cli.ts` 使用 `bun build --compile`，通过 `compiled-runtime-entry.ts` 将 Copis CLI 和 Pi Worker 编译为同一个 Bun 二进制；普通 CLI 参数进入 CLI，内部 `copis __pi-worker` 子命令进入 Pi Worker。
- 构建产物按平台和架构放在 `apps/electron/resources/bin/{platform}-{arch}/`：Windows x64 为 `win32-x64/copis.exe`，macOS ARM 为 `darwin-arm64/copis`，macOS Intel 为 `darwin-x64/copis`；Linux runner 也使用对应的 `linux-{arch}/copis` 目录。
- `build:cli` 会把 `photon_rs_bg.wasm` 复制到同一平台目录；不能只复制 `copis` 而遗漏该运行时资源。
- `electron-builder.yml` 通过 `extraResources` 将上述目录复制到 `process.resourcesPath/bin/`。主进程使用 `resolveBundledCliPath()` 按当前平台/架构选择二进制，并保留旧版 `resources/bin/copis(.exe)` 作为兼容回退。
- 正式包启动 Rust HTTP API 时注入 `COPIS_PI_RPC_COMPILED_RUNTIME=1`、`COPIS_PI_RPC_EXECUTABLE` 和 `COPIS_CLI`；Rust `PiWorkerManager` 必须执行 `<copis> __pi-worker`，不能再寻找 `node/node.exe` 或其他托管 Node runtime。
- 正式包找不到当前平台的组合二进制时，应报告“未找到打包的 Copis runtime，请重新安装或重新构建应用”，不能退回 Node runtime 并产生误导性的 Node 缺失错误。
- 开发环境不要求生成 `copis.exe`：`bun run dev` 使用 `dist/pi-rpc-worker.cjs`，通过系统 Bun 或 `vendor/bun` 启动，并设置 `COPIS_PI_RPC_USE_SYSTEM_RUNTIME=1`；开发构建可以继续使用 JS Worker 热重载路径。

**Automation 与 Pi Worker 归属（必须遵守）：**
- Rust HTTP API 是 Automation 的唯一执行方：负责 30 秒 tick、手动立即运行、同任务运行保留、Pi Worker 启动/结束、`automations.json` 运行历史与下次运行时间、连续失败 5 次自动暂停，以及 Worker Automation capability 的签发和撤销。
- Electron 不得再用 `setInterval`、`runAgentHeadless()` 或 Electron 侧 Worker 管理执行 Automation；仅可通过私有 stdio business bridge 为 Rust 提供加密后的渠道凭据、会话配置与 JSONL/元数据持久化，并转发渲染事件和通知。
- Automation Worker 的 capability 只能由 Rust 在 Worker 启动前注入，并必须在启动失败的所有路径和 `PiWorkerManager.finish()` 中撤销；不得让 capability 跨进程、跨会话或 Worker 生命周期复用。
- 应用恢复时，过期的 `interval`、`daily`、`weekly`、`monthly` 任务应顺延到下一次完整周期，避免集中补跑；过期的 `once` 任务仍保持待执行。
- Rust 通过 `/api/internal/automation/prepare-run`、`event`、`run-finished` 调用 Electron 私有桥接。`event` 必须进入 `AgentEventBus`，`run-finished` 必须发送标准 `STREAM_COMPLETE`，不能单独实现另一套渲染状态机。

**工作区项目 Node runtime 要求（必须遵守）：**
- `node-runtime` 功能模块只服务工作区内用户项目的 `npm install`、`npm run dev` 等项目命令，不替代 Pi Worker 的 Bun 组合运行时。
- Electron 启动 Rust HTTP API 时，将已激活的 Node runtime 根目录通过 `COPIS_RUNTIME_ROOT` 注入；Rust 项目启动器必须从该目录解析绝对的 `node` / `npm` 路径，不能依赖用户系统 PATH 中是否安装 Node.js。
- Pi Agent 默认提供 `read`、`write`、`edit`、`bash` 四个基础工具。`bash` 在 Rust 文件 API 模式下由 Rust 校验会话权限后执行，只允许工作区内的依赖安装、构建、测试和本地开发命令；Agent 不得因为系统 PATH 中没有 `node` 或 `npm` 就要求用户安装运行时。
- Agent 安装项目依赖时，应在当前项目目录单独调用 `bash` 的 `npm install`，随后再单独调用 `npm run build` 验证；禁止使用 `--prefix`、管道、重定向、命令替换或 `&&`/`;` 串联命令。
- 项目列表只发现工作区 `project/` 下包含 `package.json` 和 Vite `dev` 脚本的项目；每个项目需要持久化独立端口，启动成功后由 Electron 内置浏览器打开对应地址。
- Agent 创建前端项目必须使用 Vue 3 + Vite，不能只生成单独的 HTML 文件；完成后必须先安装依赖并验证 `npm run dev` 可启动。

**跨平台打包检查：**
- Pi 的原生依赖按当前平台安装和同步；在目标平台分别执行构建，不能用单个平台的 `node_modules` 代替其他平台产物。
- 修改 external 依赖后，先运行 `bun run sync:runtime-deps`，再执行 `bun run dist:fast` 或对应平台的 `dist:*` 命令。
- 本地测试打包后的应用 Agent 功能，确认 Pi 可以启动、调用工具、恢复 session，并检查产物中没有已移除的旧 runtime binary 或包。

**其他依赖的打包策略：**
- `electron` 由 Electron 运行时提供，必须 external。
- Pi runtime、`pdfjs-dist`、`sharp` 属于主进程 external 运行时依赖，必须由同步脚本复制并由 electron-builder 打包。
- **所有其他依赖**（如 `electron-updater`、`undici`、`chokidar` 等）应该让 esbuild 打包进 `main.cjs`。
  - ✅ 优点：避免遗漏子依赖，简化 electron-builder 配置。
  - ❌ 如果标记为 external：必须在 `electron-builder.yml` 的 `files` 中手动列出所有子依赖。
- **常见错误**：将普通 npm 包标记为 external 但忘记在 `files` 中包含，导致打包后找不到模块（如 `Cannot find module 'universalify'`）。

**默认 Pi 扩展打包要求（必须遵守）：**
- 每个 Pi Agent 会话默认加载 `pi-web-access`（`web_search`、`fetch_content`、`source_check`、`get_search_content`），通过 `pi-agent-adapter.ts` 的 `DefaultResourceLoader.additionalExtensionPaths` 注入，不需要用户手动 `pi install`。
- 打包后的 Pi Worker 是自包含 Bun 二进制，无法读取 `app.asar` 内的 node_modules，因此扩展必须落在真实磁盘目录：`scripts/copy-pi-extensions.ts` 会把扩展及其依赖闭包复制到 `resources/pi-extensions/`，再由 `electron-builder.yml` 的 `extraResources` 打入 `process.resourcesPath/pi-extensions`。
- 主进程启动 Rust HTTP API 时注入 `COPIS_PI_EXTENSIONS_DIR`，worker 从该目录解析扩展入口；开发模式未注入时回退到仓库 node_modules 解析（见 `src/main/lib/adapters/pi-default-extensions.ts`）。
- 修改默认扩展清单时，必须同步更新 `scripts/copy-pi-extensions.ts` 与 `src/main/lib/adapters/pi-default-extensions.ts` 两处的包名列表；新增扩展需确保其运行时依赖闭包能完整复制（jiti 会从扩展入口所在目录向上解析依赖）。
- 扩展工具由 Pi 的 ExtensionRunner 提供 `ExtensionContext`（含 modelRegistry / cwd / isProjectTrusted），不经过 Copis 的 `canUseTool` 权限包装；新增默认扩展前要评估其工具是否存在文件系统副作用。

## 代码风格

- 永远不要使用 `any` 类型 — 创建合适的 interface
- 对象类型优先使用 interface 而不是 type
- 尽可能使用 `import type` 进行仅类型导入
- 注释和日志采用中文，保留专业术语
- Rust 测试代码必须与生产实现分离：每个生产模块的测试放在同目录、同名的 `*_test.rs` 文件中（例如 `working_payment.rs` 对应 `working_payment_test.rs`）；不得在 `main.rs` 或其他生产代码文件中内嵌 `#[cfg(test)]` 测试模块。
- **路径别名**：`@/` → `apps/electron/src/renderer/`

## TypeScript 配置

- Module: `"Preserve"` + `"moduleResolution": "bundler"`
- JSX: `"react-jsx"`，严格模式启用，Target: ESNext
- 所有包 `"type": "module"`，导入时使用 `.ts` 扩展名

## 版本管理

提交代码时始终递增受影响包的 patch 版本（如 `0.1.18` → `0.1.19`），影响多个包则都要递增。

### 默认 Skills 版本契约（`apps/electron/default-skills/`）

修改任何 `default-skills/<skill>/` 内容时，**必须同步递增该 Skill `SKILL.md` frontmatter 的 `version` 字段**（patch +1）。

**为什么**：`seedDefaultSkills()` 与 `upgradeDefaultSkillsInWorkspaces()` 通过 semver 比较决定是否将 bundle 中的 Skill 同步到老用户的 `~/.copis/default-skills/` 与各工作区。**version 不变 = 老用户拿不到新内容**。

**早期实现曾用"无条件 cpSync"绕开这个约束**，但每次启动同步 4MB+ 文件会阻塞主进程导致启动卡顿，已恢复为 semver 比较（见 `config-paths.ts:seedDefaultSkills`、`agent-workspace-manager.ts:upgradeDefaultSkillsInWorkspaces`）。

**新增 Skill 不需要先注入 default-skills 目录的旧版本**——`upgradeDefaultSkillsInWorkspaces` 会通过"目标缺失即注入"路径让所有老工作区自动获得。

## Pi Agent SDK 集成架构

Copis 的 Agent 模式基于 `@earendil-works/pi-coding-agent@0.82.1`、`pi-agent-core@0.82.1` 和 `pi-ai@0.82.1`，与 Chat 模式共享 Provider 配置，但由 Pi 负责 Agent session、工具调用、推理和上下文压缩。

### 核心流程

```
用户输入 → agent-orchestrator.ts (Pi 编排)
  ↓
Pi AgentSession → Pi AgentMessage / AgentSessionEvent 流
  ↓
pi-message-adapter.ts → 统一 SDKMessage / AgentEvent 协议
  ↓
webContents.send() → IPC 推送
  ↓
useGlobalAgentListeners (全局监听) → store.set(atoms)
  ↓
React UI 更新
```

### 关键组件

#### agent-orchestrator.ts
- **并发守卫**：同一会话不允许并行请求。
- **渠道管理**：查找渠道、解密 API Key、动态构建 Pi provider。
- **运行环境**：构建 Pi shell、代理、CLI 和工作区环境。
- **消息持久化**：将统一消息和 Pi session artifact 保存到 JSONL。
- **事件流处理**：累积文本、工具调用、重试和上下文压缩事件。
- **错误处理**：统一映射网络、供应商、上下文和权限错误。

#### pi-agent-adapter.ts
- **Pi session**：创建、恢复、中断、分叉和回退 Pi AgentSession。
- **工具桥接**：接入 Pi 原生工具、MCP 工具、Skills 和 Copis 权限策略。
- **默认扩展**：通过 `DefaultResourceLoader.additionalExtensionPaths` 为每个会话注入 `pi-web-access`（联网搜索、网页抓取、来源核查），由 Pi 负责扩展加载、`ExtensionContext` 注入和 session 持久化；扩展缺失时仅告警跳过，不阻断会话。
- **模型兼容**：按 ProviderType 动态构建 Anthropic、OpenAI、Google 及兼容模型。

#### agent-prompt-builder.ts / agent-permission-service.ts
- **系统提示词**：注入工作区、项目根目录、Skills、MCP 和记忆上下文。
- **权限模式**：基于权限规则执行 safe / ask / allow-all。

### 关键设计

- **Pi 调用**：`PiAgentAdapter` 将 `AgentQueryInput` 转换为 Pi `AgentSession` 查询选项。
- **事件转换**：`pi-message-adapter.ts` 将 Pi 消息转换为 `SDKMessage` 和统一 `AgentEvent` 类型。
- **工具匹配**：`packages/shared/src/agent/tool-matching.ts` 使用无状态 `ToolIndex` 解析工具调用。
- **状态管理**：`applyAgentEvent()` 纯函数更新 `AgentStreamState`，支持流式增量更新。
- **全局 IPC 监听**：`useGlobalAgentListeners` 在 `main.tsx` 顶层挂载，确保页面切换时流式输出、权限请求和后台任务不丢失。
- **权限请求排队**：权限/AskUser 请求按 sessionId 入队到 Map atoms，SDK Promise 等待用户回来响应。
- **工作区隔离**：每个工作区拥有独立的 MCP、Skills、cwd 和 Pi session artifact。
- **默认扩展凭据**：`pi-web-access` 优先复用当前 OpenAI 渠道或环境变量中的 API Key（如 `OPENAI_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY`），也可通过 `~/.pi/web-search.json` 配置；未配置任何供应商时工具返回配置引导。

**子智能体（Browser Workflow 总结 Agent）默认使用 DeepSeek v4 Flash + high 优先级配置**（通过 `agentChannelId` / `agentModelId` fallback 到 DeepSeek 系列模型）。

### 共享类型（`@copis/shared`）

- `AgentEvent`：Agent 事件（text / tool_start / tool_result / done / error）
- `AgentSessionMeta`：会话元数据（id / title / channelId / workspaceId）
- `AgentMessage`：持久化消息（role + content blocks）
- `AgentSendInput`：发送请求输入
- `AGENT_IPC_CHANNELS`：Agent 相关 IPC 通道常量
- `WorkspaceCapabilities`：工作区能力（MCP Server 列表 + Skills 列表）

## 创作参考

遵循 [craft-agents-oss](https://github.com/craftship/craft-agents-oss) 的模式：

- **会话管理**：收件箱/归档工作流
- **权限模式**：safe / ask / allow-all
- **Agent SDK**：`@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`
- **MCP 集成**：Model Context Protocol 用于外部
- **凭证存储**：AES-256-GCM 加密
- **配置位置**：`~/.copis/`（类似 `~/.craft-agent/`）

## 核心特性

### 已实现功能

- ✅ **多 Provider 支持**：Anthropic、OpenAI、DeepSeek、Kimi、智谱、MiniMax、豆包、通义千问、Google、自定义端点
- ✅ **Pi Agent 集成**：基于 Pi Agent SDK 的完整 Agent 模式
- ✅ **飞书集成**：消息同步、任务通知、OAuth 认证（68KB 核心服务）
- ✅ **工作区管理**：多工作区隔离、MCP Server 配置、Skills 管理
- ✅ **权限系统**：工具权限检查、用户确认流程
- ✅ **自动更新**：Electron Updater 集成
- ✅ **代理支持**：系统代理检测与配置
- ✅ **文档解析**：PDF、Office、文本文件提取
- ✅ **多模态支持**：图片、文档附件
- ✅ **Chat 工具**：内置工具系统 + 动态加载

### 架构亮点

- **并发守卫**：同一会话防止并行请求冲突
- **全局监听**：Agent IPC 监听器永不销毁，确保后台会话不丢失
- **权限排队**：按 sessionId 隔离权限请求，支持多会话并行
- **文件监听**：项目根目录、会话文件、附加目录、MCP 配置与 Chat 工具实时监控
- **事件流处理**：SDK 消息流式转换与累积
- **错误映射**：SDK 错误统一转换为应用错误

### Browser Workflow 录制边界

- Browser Workflow 只支持 Pi Agent；CDP 只由 Electron 主进程内部使用，Renderer、Preload、HTTP bridge 和 MCP 不暴露任意 CDP。
- Pi Worker 的普通 Agent 会话也会获得受限的 AI浏览器 capability。没有 Browser Context 时，只允许用户主会话调用 `BrowserPageOpenTab` 直接创建一个 HTTP(S) 内部页签，并自动把新页签绑定到该会话；用户主会话的跨 Origin 导航和新页签也不请求单次审批。`automation` 和 `delegation` 触发源不得创建首个页签，其他 Browser Page 工具在未绑定时一律拒绝。
- Composer 的“高级授权”是用户主会话 AI浏览器的会话级总开关：开启后，已绑定内部页签视为授权模式，导航、点击、输入、选择、按键、滚动、新页签和敏感字段操作均可按用户明确目标直接执行；文件上传只允许通过 `BrowserPageUpload` 使用当前 Agent 工作区或已附加文件范围内的路径。关闭后恢复每页 Origin 授权策略。`automation`、`delegation` 不得继承该能力，且 Worker capability、页签 owner、HTTP(S)、Origin/URL、`event.isTrusted` 校验始终保留。
- 首建页签由主进程绑定时暂时没有 Renderer owner。`browser-workflows:session-for-tab` 只允许主渲染窗口查询该页签的会话，`WebBrowserSurface` 恢复并首次认领绑定后，原有跨 Renderer owner 拒绝规则继续生效；不能依赖可能早于组件挂载发出的状态事件。
- 页面操作由主进程完成 nonce、Origin、URL 和 `event.isTrusted` 校验，并在进入 Rust API 前移除普通输入字面值和敏感值。
- Rust 本地 HTTP API 是录制操作 JSONL 的文件事实源：`~/.copis(-dev)/agent-workspaces/{workspace}/browser-recordings/{recordingId}.jsonl`。Electron 通过内部 token 调用 start/event/finish/cancel/content 端点，事件按链路串行追加。
- 停止录制后，Pi 工具 `BrowserWorkflowRecordingGet` 将脱敏 JSONL 标记为 untrusted browser data 提供给 Agent；Agent 通过 `BrowserWorkflowDraft` 总结步骤、变量、Origin 和人工检查点，主进程重新校验后才允许用户批准保存。
- Renderer 的停止操作只结束采集并触发同一 Pi session 读取 JSONL，不直接接收或编译原始录制内容。
- `browserWorkflowEnabled` 默认开启；开发模式始终开启，打包版显式设置为 `false` 可关闭。Browser Agent 通过共享 `AgentConversationSurface` 的 `browser` variant 渲染，不直接挂载完整 `AgentView`。
- 真实 Runner 回放命令为 `bun run --filter='@copis/electron' test:browser-workflow:e2e`；harness 使用临时 HOME、userData 和本地 HTTP fixture，覆盖跨 Origin iframe、popup、React controlled input、Locator 歧义与 CDP detach/resume，并在退出时清理临时目录。

**首建页签 BDD 回归场景：**

```text
Given 用户主会话尚未绑定 Copis 内部网页页签
When Agent 调用 BrowserPageOpenTab 打开 HTTP(S) 地址
Then 主进程创建并激活新页签，将其绑定到该会话
And 页面宿主可按页签恢复会话和侧栏，并首次认领 Renderer owner

Given 用户主会话已绑定并处于授权模式的网页页签
When Agent 调用 BrowserPageNavigate 或 BrowserPageOpenTab 打开跨 Origin HTTP(S) 地址
Then 直接执行导航或创建页签，不请求单次审批

Given 用户主会话已绑定网页页签且 Composer 高级授权已开启
When Agent 执行普通或敏感页面操作
Then 页面状态为 authorized 并直接执行，不显示“询问模式”提示

Given automation 或 delegation 会话尚未绑定 Copis 内部网页页签
When Agent 调用 BrowserPageOpenTab
Then 在请求审批或创建页签前拒绝该调用
```

修改首建页签链路后至少执行：

```bash
bun test apps/electron/src/main/lib/browser-agent-worker-capability.test.ts
bun test apps/electron/src/main/lib/browser-agent-tool-service.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
bun test apps/electron/src/main/lib/browser-page-control-service.test.ts
bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
```
