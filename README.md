# Copis

Copis 是一个本地优先的 AI 桌面应用，把多模型 Chat、通用 Agent、工作区、Skills、MCP、远程机器人和记忆能力放在同一个开源客户端里。

它不是只面向闲聊的聊天框，而是一个可以长期沉淀个人工作流的 Agent 工作台：简单问题用 Chat，复杂任务交给 Agent，数据和配置尽量留在本地。

![Copis 海报](https://img.erlich.fun/personal-blog/uPic/pb.png)

<video width="560" controls>
  <source src="https://img.erlich.fun/personal-blog/uPic/%E7%AE%80%E5%8D%95%E4%BB%8B%E7%BB%8D%20Copis.mp4" type="video/mp4">
</video>

[English README](./README.en.md) | [新手教程](./tutorial/tutorial.md) | [下载开源版](https://github.com/ErlichLiu/Copis/releases) | [下载商业版](https://copis.cool/download)

> **最新思考 ｜ 2026 Q2–Q3**：[勇敢地解决真实的问题 — Proactive · 个人注意力 · 团队协作](./copis-thinking/copis-2026-q2-q3-thinking.md) ｜ 往期思考：[2026 Q1](./copis-thinking/copis-2026-q1-thinking.md)

## 现在能做什么

- **Chat 模式**：多模型对话、附件解析、图片输入、Markdown / Mermaid / KaTeX / 代码高亮、并排对话、系统提示词、上下文管理。
- **Agent 模式**：基于 Pi Agent SDK 的统一运行时；支持工作区隔离、权限模式、文件操作、长任务流式输出、计划确认和用户追问。可通过 Pi 调用 Anthropic、Claude、OpenAI、Google 及兼容渠道的模型，且每个会话默认内置联网搜索与网页抓取扩展（pi-web-access）。
- **协作与多 Agent 专家团队**：复杂任务可拆分为可追踪的协作子 Agent / Task，支持专家团队（Expert Team）与多 Agent 协同，并在消息流中展示调用过程和结果。
- **Skills、MCP 与项目根目录**：每个 Copis 项目独立配置 Skills 与 MCP Server。项目文件可使用用户选择的本地项目根目录，也可使用 Copis 托管的空白项目目录；本地项目配置不会被自动导入。工作区的 `project/` 目录用于 Agent 创建和维护用户项目。
- **内嵌 AI 浏览器与自动化工作流**：原生多页签 Chromium 浏览器，支持会话绑定与独立收藏夹浮层；提供网页元素交互、高级授权护盾，以及基于 Playwright 的浏览器操作录制与工作流执行（Browser Workflow）。
- **Copis CLI 与命令行会话能力**：内置 `@copis/cli` 工具，面向终端用户和有限上下文的 Agent 消费者，提供会话的渐进式读取、搜索与导出（`list` / `info` / `outline` / `search` / `export`）。
- **远程机器人与 App 连接器**：支持飞书（Hermes 扫码一键注册）、微信（腾讯 iLink Bot 扫码登录）与钉钉（Stream 直连 / OAuth 扫码授权）机器人桥接；侧边栏提供对应平台色彩专属 Tag 徽标，会话自动剥除信封并提取真实用户提问作为标题，支持用手机随时随地触发本机 Agent 工作流。
- **QM 风格结构化记忆**：参考 YC QM 项目设计，由本地 Rust HTTP API 与 SQLite 驱动；支持用户全局与工作区专属两级 Scope 隔离、Per-turn 自动事实抽取、Token 阈值排队整理、版本历史追溯（Revision 乐观锁）以及 Agent 受控记忆读写工具集。
- **本地优先**：会话、工作区、附件、配置、Skills 等默认存储在 `~/.copis/`，使用 JSON / JSONL 文件组织，不依赖本地数据库。
- **桌面体验**：自动更新、代理设置、文件预览、全局快捷键、快速任务窗口、语音输入、亮色 / 暗色 / 跟随系统主题。

## 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/ErlichLiu/Copis/releases) 下载开源版本，提供 macOS Apple Silicon、macOS Intel 和 Windows 安装包。

开源版可独立使用，并支持自行配置 AI 供应商渠道。如果你更希望使用 Copis 提供的内置模型渠道和订阅方案，也可以按需了解 [Copis 商业版](https://copis.cool/download)。两个版本面向不同的使用偏好，你可以自由选择适合自己的版本。

| 对比项 | 开源版 | 商业版 |
| --- | --- | --- |
| 核心桌面能力 | 完整的 Copis 桌面体验，可自由配置工作流 | 保留同样的核心桌面体验 |
| 模型渠道 | 自行添加和管理 AI 供应商渠道与 API Key | 登录后可使用 Copis 官方内置模型渠道，也仍可自行配置第三方渠道 |
| 模型价格 | 按所选供应商的规则和价格使用 | 精选模型提供 Copis Cloud 专属优惠，部分模型最高可低至官方参考价 2 折 |
| Agent 安全与稳定 | 需自行评估供应商的安全、协议兼容与稳定性；使用第三方中转站时也需自行判断额外的信任与数据处理风险 | 使用 Copis Cloud 官方托管链路，提供统一的安全与稳定性保障、Agent 协议兼容和模型健康监控，减少不透明第三方中转带来的不确定性 |
| 联网与内嵌 AI 能力 | 按需自行配置搜索、生图等服务及对应 API Key | 提供更完整的 Copis Cloud 联网与内嵌能力，包括 WebSearch，以及 GPT Image 2 生图和编辑 |
| 对外 API 与服务 | 主要使用你自行配置的供应商 API | 可创建独立、可设额度上限的 Copis Cloud API Key，将 LLM、工具和多模态能力接入自己的应用或服务 |
| 团队额度管理 | 需自行搭建成员、额度分配与用量管理机制 | 团队管理员可向成员分配或回收共享团队额度，支持按月自动分配，并查看成员用量与额度流水 |
| 订阅与用量 | 自行管理供应商账号、余额与用量 | 在应用内管理订阅与余额，并查看模型、Agent 和工具的用量明细 |
| 从开源版切换 | — | 直接覆盖安装即可，继续使用已有的本地 Copis 数据 |

> 可用模型、价格和权益会随时间调整，以应用内当期展示为准。

### 企业版与商业授权

如果你的组织计划面向数百至数千名员工规模部署 Copis，可以采购企业版授权；我们也可围绕实际部署需求提供范围明确的轻量定制服务。欢迎通过微信联系：`geekthings`。

### 首次配置

1. 打开 Copis，先完成环境检查。Agent 模式依赖本机基础环境，尤其是 Git 和可用的 Shell。运行工作区项目所需的 Node.js 与 npm 会由 Copis 的功能模块自动准备，无需用户另行安装 Node.js。
2. 进入 **设置 > 渠道**，添加至少一个 AI 供应商渠道，填写 Base URL、API Key 和模型列表。
3. Chat 模式可以使用 OpenAI、Anthropic、Google 或 OpenAI 兼容协议的渠道。
4. 默认的 Pi Agent Runtime 可使用已启用的模型渠道，包括 Anthropic、DeepSeek、Kimi API、Kimi Coding Plan、OpenAI、Google 及兼容端点。
5. Agent 输入框下方可直接选择模型和执行设置；Pi 会根据渠道协议连接对应模型。
6. 进入 **设置 > Agent**，选择默认 Agent 渠道、模型和工作区。
7. 如需记忆、联网搜索、飞书 / 钉钉 / 微信桥接，在设置页对应 Tab 中继续配置。

## 模式选择

### Chat 适合

- 日常问答、解释、翻译、润色、轻量代码讨论。
- 读取附件内容后做总结、改写、比较。
- 使用联网搜索或记忆工具增强一次性对话。
- 同时对比多个模型输出，或用不同系统提示词做探索。

### Agent 适合

- 修改、创建、整理本地文件。
- 调研、编写报告、处理多步骤任务。
- 使用 MCP、Skills、Shell、Git、项目文件等外部上下文。
- 需要权限确认、计划模式、后台任务或远程机器人持续跟进的工作。

简单说：**只需要回答时用 Chat，需要行动和交付结果时用 Agent。**

### 在工作区开发项目

Agent 可以在工作区的 `project/` 目录中创建项目。项目列表会自动发现包含 `package.json` 和 Vite `dev` 脚本的项目；点击项目右侧的启动按钮后，Rust HTTP API 会使用 Copis 内置的 Node.js + npm runtime 执行 `npm run dev`，并为每个项目持久化分配独立端口，启动成功后在右侧内置浏览器打开地址。

项目建议使用 Vue 3 + Vite 构建。Agent 创建项目时应先执行依赖安装，再启动开发服务；如果项目依赖尚未安装，可由 Agent 通过 Rust 项目命令接口执行 `npm install`，不需要用户打开终端手动操作。

Pi Agent 的基础工具是 `read`、`write`、`edit` 和 `bash`。项目命令由 Copis 内置 Node.js/npm runtime 执行，Agent 不应要求用户另行安装 Node.js/npm；命令需要逐条调用，不能使用管道、重定向或串联语法。

### 使用内嵌 AI浏览器

在 Agent 对话中直接提出“打开 https://example.com 并继续操作”。当会话尚未绑定网页时，Agent 会直接在 Copis 内部创建并激活 HTTP(S) 网页页签，自动绑定当前会话并恢复网页 Agent 侧栏。用户明确要求的跨站地址也会直接打开，不再产生单次确认。之后 Agent 可在既有网页授权边界内继续观察和操作页面。

Composer 的“高级授权”护盾开启后，当前用户主会话绑定的 AI浏览器页签默认放行导航、点击、输入、选择、按键、滚动和新页签操作，包含密码、验证码、支付、文件上传、Captcha 与 secret 字段；文件上传通过 `BrowserPageUpload` 使用当前 Agent 工作区或已附加文件范围内的路径。关闭后恢复页面自身的询问/授权策略。该开关不会授予系统浏览器或外部 Chrome 权限。

AI浏览器只能控制 Copis 内部页签，不能控制系统浏览器或外部 Chrome。自动化和委派会话不能创建首个网页页签，也不会继承 Composer 高级授权；Worker capability、页签归属、HTTP(S)、Origin/URL 和页面可信事件校验仍然生效。

## 截图

### Chat 快速分析

用 Chat 处理轻量但真实的分析任务：整理读者关注点、生成对比表，并把首屏文案快速定稿。

![Copis Chat 快速分析](./docs/assets/screenshots/copis-chat-demo.png)

### Agent 工作台

Agent 在项目根目录与会话工作台中读取文件、推进任务、输出表格化结论，并把可复用文件保留在右侧文件面板中。

![Copis Agent 工作台](./docs/assets/screenshots/copis-agent-demo.png)

### Skills

每个工作区都可以沉淀专属 Skills。截图中的 `feedback-synthesis` 用于把用户反馈、访谈记录和 issue 聚合成主题、证据与优先级建议。

![Copis 工作区 Skills](./docs/assets/screenshots/copis-skills-demo.png)

### Skills & MCP

同一个工作区可以管理 stdio / HTTP MCP Server，按需启用或关闭，让 Agent 在不同项目里获得不同的外部上下文。

![Copis MCP 配置](./docs/assets/screenshots/copis-mcp-demo.png)

### 流式语音输入(支持全局输入)
Copis 支持豆包的流式语音输入功能，并且支持在 Copis 内使用和 Copis 外部使用：
- Copis 内部使用：Ctrl + ` 触发识别，再次按下结束自动输入到 Copis 内对应的输入框
- Copis 外部使用：Ctrl + ` 触发识别，再次按下结束自动输入到当前的光标所在处，如无光标则默认写入到剪贴板
- 
![Copis 语音输入](./docs/assets/screenshots/copis-typeless-input.png)

## Agent 运行时与模型渠道

Copis 的 Agent 模式统一使用 Pi Agent Runtime，基于 `@earendil-works/pi-coding-agent`、`pi-agent-core` 和 `pi-ai`，将 Copis 的已启用渠道动态注册为 Pi provider；支持 OpenAI Chat Completions / Responses、Google Generative AI、Anthropic Messages 及其兼容端点。

| 渠道类型 | Chat | Pi Agent |
| --- | --- | --- |
| Anthropic / Anthropic 兼容 | 支持 | 支持 |
| DeepSeek、Kimi API / Coding Plan、智谱 Coding Plan、MiniMax、小米 MiMo 等 Anthropic 协议渠道 | 支持 | 支持 |
| OpenAI、OpenAI Responses、Google、智谱 AI、豆包、通义千问 | 支持 | 支持 |
| OpenAI 兼容自定义端点 | 支持 | 支持 |
| ChatGPT 订阅（Codex OAuth） | — | 支持 |
| xAI 订阅（Grok OAuth） | — | 支持 |

> Pi Runtime 会为每个 Agent 会话管理底层 session，但不会删除 Copis 中已保存的消息。Pi 会桥接工作区 Skills、用户 MCP Server，以及 Copis 内置的 Automation / Collaboration 工具；不同模型供应商对工具调用、推理和上下文长度的支持仍可能不同。

### Automation 运行时

定时任务由本地 Rust HTTP API 统一调度和执行：它负责 30 秒轮询、立即运行、Pi Worker 生命周期、一次运行记录、下一次触发时间与连续失败自动暂停。Electron 只通过私有桥接提供加密渠道凭据、会话 JSONL 持久化、界面事件和通知，不再拥有独立的定时器或后台 Agent 执行链。

每个 Pi Worker 在启动时由 Rust 签发一次受限的 Automation capability，仅可访问当前 Rust API 进程中的任务工具端点；Worker 结束或启动失败后立即撤销。这样任务工具、能力授权与实际执行始终在同一个 Rust 进程中，避免开发版与已安装应用端口不同导致 capability 失效。

恢复应用时，错过的循环任务会被顺延到下一个完整周期；错过的一次性任务仍会保留为待执行。连续失败 5 次的任务会自动暂停，运行历史保存在 `~/.copis/automations.json`。

每个 Pi Agent 会话默认内置 [pi-web-access](https://github.com/nicobailon/pi-web-access) 扩展，无需手动 `pi install`，即可使用 `web_search`（联网搜索）、`fetch_content`（网页抓取）、`source_check`（来源核查）和 `get_search_content`（结果检索）工具。搜索供应商优先复用当前 OpenAI 渠道或环境变量中的 API Key（如 `OPENAI_API_KEY`、`TAVILY_API_KEY`、`EXA_API_KEY`），也可通过 `~/.pi/web-search.json` 配置；未配置任何供应商时，工具会返回配置引导而非报错中断。

### QM 风格结构化记忆系统

Copis 深度参考了 YC QM 项目的结构化长期记忆设计，将其完整落地为由本地 Rust HTTP API 和本地 SQLite 驱动的高性能、可追溯记忆系统：

- **分级 Scope 隔离**：分为 `user`（全局用户偏好、语言习惯、个人通用知识）与 `workspace`（工作区专属项目知识、环境配置、业务决策）两级边界，严格杜绝跨项目上下文污染。
- **结构化记忆类型**：划分 `fact`（客观事实）、`preference`（个人偏好）、`decision`（架构与业务决策）、`project`（项目结构与技术栈）及 `scratch`（短期临时笔记，14 天保留期）。
- **全自动感知与维护**：
  - **Per-turn 自动抽取**：对话流结束后，后台轻量模型自动提取用户对话中的新事实与偏好并完成沉淀；
  - **智能排队整理与提炼**：上下文 Token 超过整理阈值时自动触发维护队列，执行临时记忆提炼（`promote`）、合并重写（`rewrite`）与旧记忆归档（`archive`），助力上下文压缩（Compaction）；
  - **动态 Top-K 注入**：新会话与对话轮次开始时，按当前工作区与语义关键词自动召回最相关记忆注入 Agent 系统提示词。
- **版本控制与受控工具集**：全量操作记录于 `memory_revisions` 表，支持乐观锁版本控制；Agent 通过受控的 `memory_recall`、`memory_read`、`memory_capture`、`memory_rewrite` 工具协同，无法越权访问底层内部路径。
- **知识库导入与导出**：支持导入 Copis / QM 导出的 JSON 数据包，以及 Markdown 分级笔记或 Bullet 事实列表（自动识别分类与 `#tag` 标签），并在本地 Rust SQLite 事务中完成智能去重与 Revision 快照记录；支持导出 Markdown / JSON 格式知识包。

## 本地数据

Copis 采用本地文件存储，方便备份、迁移和排查问题。

```text
~/.copis/
├── channels.json
├── conversations.json
├── conversations/
│   └── {conversation-id}.jsonl
├── agent-sessions.json
├── agent-sessions/
│   └── {session-id}.jsonl
├── agent-workspaces/
│   └── {workspace-slug}/
│       ├── workspace-files/ # Copis 托管的工作区文件根
│       │   └── project/     # Agent 创建和运行的用户项目目录
│       ├── mcp.json
│       └── skills/
├── attachments/
├── user-profile.json
├── settings.json
└── sdk-config/
```

API Key 会通过 Electron `safeStorage` 加密后写入 `channels.json`。Copis 不使用本地数据库，核心数据结构以 JSON 配置和 JSONL 追加日志为主。

## 开发

Copis 是 Bun workspace monorepo。

```text
copis/
├── packages/
│   ├── shared/        # 共享类型、IPC 常量、配置、工具函数 (v0.1.71)
│   ├── core/          # Provider Adapter、SSE、代码高亮 (v0.2.18)
│   ├── session-core/  # 无头会话解析、搜索、过滤与 Markdown 导出核心 (v0.1.2)
│   └── ui/            # 共享 React UI 组件 (v0.1.10)
├── apps/
│   ├── electron/      # Electron 桌面应用 (v0.0.74)
│   └── cli/           # Copis 命令行工具（渐进式会话提取与导出） (v0.1.1)
└── native/
    └── http-api-server/ # 本地 Rust HTTP API（记忆、调度、更新、项目端口分配）
```

当前主要包版本：

| 包 | 版本 | 职责 |
| --- | --- | --- |
| `@copis/electron` | `0.0.74` | Electron 桌面应用主体 |
| `@copis/shared` | `0.1.71` | 共享类型、IPC 常量、配置和工具 |
| `@copis/core` | `0.2.18` | Provider Adapter、SSE、Shiki 高亮 |
| `@copis/session-core` | `0.1.2` | 无头会话解析、过滤、搜索与 Markdown 渲染核心 |
| `@copis/ui` | `0.1.10` | 共享 React UI 组件 |
| `@copis/cli` | `0.1.1` | 面向终端与 Agent 的会话渐进式读取与导出 CLI |

常用命令：

```bash
# 安装依赖
bun install

# 开发模式：自动启动 Vite + Electron + 热重载
bun run dev

# 构建 Electron 应用
bun run electron:build

# 构建并运行
bun run electron:start

# 类型检查
bun run typecheck

# 测试
bun test

# 编译 Copis CLI 二进制产物
bun run build:cli

# 打包工作区项目所需的 Node.js + npm runtime 功能模块
bun run build:node-runtime-module -- --output /tmp/copis-node-runtime.tar.gz
```

Electron 子应用内也提供更细的脚本：

```bash
cd apps/electron

bun run dev:vite
bun run dev:electron
bun run build:main
bun run build:preload
bun run build:renderer
bun run copy:pi-extensions   # 复制默认 Pi 扩展（pi-web-access）及依赖闭包到 resources/pi-extensions/
bun run dist:fast
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| 桌面框架 | Electron 43.2.0 |
| 前端 | React 18 + TypeScript |
| 状态管理 | Jotai |
| 样式 | Tailwind CSS + Radix UI |
| 富文本输入 | TipTap |
| Markdown / 图表 / 公式 | React Markdown + Beautiful Mermaid + KaTeX |
| 代码高亮 | Shiki |
| 构建 | Vite + esbuild |
| 分发 | electron-builder |
| Agent Runtime | Pi: `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai` `@0.84.1` |
| 默认 Pi 扩展 | `pi-web-access` `@0.22.0`（联网搜索、网页抓取、来源核查） |
| 后端与原生能力 | Rust HTTP API Server (`native/http-api-server`) + SQLite |

## 架构概览

Copis 的核心通信路径是：

```text
shared 类型和 IPC 常量
  -> main/ipc.ts 注册处理器
  -> preload/index.ts 暴露 window.electronAPI
  -> renderer Jotai atoms 和 React 组件调用
```

主进程服务集中在 `apps/electron/src/main/lib/`：

- `agent-orchestrator.ts`：Agent 编排、Pi runtime、环境变量、SDK 调用、事件流、错误处理。
- `adapters/pi-agent-adapter.ts`：Pi runtime 适配，将 Pi 消息、工具和 session artifact 接入 Copis 统一会话协议。
- `agent-session-manager.ts`：Agent 会话索引和 JSONL 消息持久化。
- `agent-workspace-manager.ts`：Copis 工作区、项目根目录、MCP 与 Skills 管理。
- `chat-service.ts`：Chat 流式调用、Provider Adapter、工具活动。
- `conversation-manager.ts`：Chat 会话索引和消息存储。
- `channel-manager.ts`：渠道 CRUD、API Key 加密、连接测试、模型获取。
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`：远程机器人桥接。
- `chat-tool-*`、`document-parser.ts`、`workspace-watcher.ts`：工具、文档解析和文件监听。

渲染进程以 Jotai 管理状态，关键 atoms 位于 `apps/electron/src/renderer/atoms/`。Agent IPC 监听器在应用顶层全局挂载，避免切换页面时丢失流式事件、权限请求或后台任务状态。

## 打包与功能模块

Copis 的功能模块体系包含 `rust-http-api`、`officecli`、`node-runtime`、`playwright-core`、`python-runtime`、`alipay-bot` 与 `agently-cli`。其中 `node-runtime` 是按目标平台打包的 Node.js 与 npm `tar.gz` 归档，应用首次启动时自动下载、校验、解包并激活。终端用户不需要自行安装 Node.js 或 npm。

部署功能模块时，`deploy.sh` / `deploy.ps1` 会在当前目标平台生成各模块归档并统一发布；发布后最终 manifest 会记录所有模块的实际版本。单模块发布支持 `--rust`、`--officecli`、`--node-runtime`、`--playwright-core`、`--python-runtime`、`--alipay-bot` 或 `--agently-cli`，每种模式都会校验其他必要模块已存在于远端 manifest。

Pi runtime 在主进程中作为 esbuild external 依赖运行。`apps/electron` 的打包脚本会在 `electron-builder` 前执行 `bun run sync:runtime-deps`，把下列依赖及其运行时闭包复制到应用目录：

- `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`
- Pi 运行时所需的原生模块和 `pdfjs-dist`

修改打包配置时，请确认：

- `build:main` / `watch:main` 将 Pi runtime 依赖标记为 external。
- `scripts/sync-runtime-deps.ts` 的 external runtime 清单与实际依赖一致。
- `electron-builder.yml` 保留 Pi native addon 的 `asarUnpack` 规则。
- 默认 Pi 扩展由 `bun run copy:pi-extensions` 复制到 `resources/pi-extensions/`，并经 `extraResources` 打入 `process.resourcesPath/pi-extensions`。打包后的 Pi Worker 是自包含 Bun 二进制，无法读取 `app.asar` 内的 node_modules，因此扩展必须保留在真实磁盘目录。
- 在目标平台测试 `bun run dist:fast` 后，验证 Pi 可以启动、调用工具和恢复会话。

更完整的工程约定见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎修 Bug、补文档、加测试、完善体验，也欢迎围绕真实场景提交新的 Skills、MCP 配置或 Agent 工作流。

提交 PR 前建议先确认：

- 使用 Bun 运行脚本，不混用 npm / pnpm lockfile。
- 状态管理使用 Jotai。
- 尽量保持本地优先，优先使用配置文件和 JSON / JSONL。
- TypeScript 不使用 `any`，对象结构优先使用 `interface`。
- 新增 IPC 时同步修改 shared 类型、main handler、preload bridge 和 renderer 调用。
- 影响包行为时递增对应 package 的 patch 版本。
- 能用测试覆盖的行为尽量补上测试，尤其是共享逻辑、IPC 契约和持久化格式。

## 作者

- 个人网站：[erlich.fun](https://erlich.fun)

## Star History

<a href="https://www.star-history.com/?repos=copis-ai%2Fcopis&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=copis-ai/copis&type=date&theme=dark&legend=top-left&sealed_token=0cHFGjNPPe5hd2uxpF1cy35N2kYGSIEnTvyIbHlGjkrrtH9rnKcBMkqA8wDWltJIlPRKFZoYyPjXItri9HhQXE1TM1rwdIe91fqTqXVcPwK6OMzGEJ9yNw" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=copis-ai/copis&type=date&legend=top-left&sealed_token=0cHFGjNPPe5hd2uxpF1cy35N2kYGSIEnTvyIbHlGjkrrtH9rnKcBMkqA8wDWltJIlPRKFZoYyPjXItri9HhQXE1TM1rwdIe91fqTqXVcPwK6OMzGEJ9yNw" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=copis-ai/copis&type=date&legend=top-left&sealed_token=0cHFGjNPPe5hd2uxpF1cy35N2kYGSIEnTvyIbHlGjkrrtH9rnKcBMkqA8wDWltJIlPRKFZoYyPjXItri9HhQXE1TM1rwdIe91fqTqXVcPwK6OMzGEJ9yNw" />
 </picture>
</a>


## 致谢

- [Shiki](https://shiki.style/)：代码高亮。
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) 与 [Mermaid](https://mermaid.js.org/)：Mermaid 图表渲染与官方兜底渲染。
- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)：多供应商桌面 AI 产品启发。
- [Lobe Icons](https://github.com/lobehub/lobe-icons)：AI / LLM 品牌图标。
- [Craft Agents OSS](https://github.com/lukilabs/craft-agents-oss)：Agent SDK 集成模式参考。

## 许可证

Copis 社区版采用 [GNU Affero General Public License v3.0（AGPL-3.0）](./LICENSE) 开源，完整条款见根目录 `LICENSE` 文件。

**个人 / 非商业使用**：自由使用、修改、分发，仅需遵守 AGPL-3.0 条款。

**商业使用**：在完全遵守 AGPL-3.0 条款的前提下允许进行商业使用，包括但不限于：以源代码或修改后的形式分发软件、通过网络对外提供服务时必须公开完整修改源码（含网络交互层）、衍生作品须以 AGPL-3.0 继续授权。

**商业授权（豁免 AGPL-3.0 义务）**：如果你希望将 Copis 集成到闭源产品、对外提供 SaaS 服务但不想公开衍生代码，或有其他无法满足 AGPL-3.0 条款的商业场景，请通过邮件联系获取商业许可：[erlichliu@gmail.com](mailto:erlichliu@gmail.com)。

向本项目提交 Pull Request 即视为同意将贡献以 AGPL-3.0 及未来商业许可形式授权给项目维护者。
