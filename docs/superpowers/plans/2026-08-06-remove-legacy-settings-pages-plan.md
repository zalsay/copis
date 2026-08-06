# 设置页面迁移与旧入口清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Copis 本地设置中的“语音输入、数据迁移、磁盘管理、外观设置”四个页面迁移到 Working 账户设置菜单，并删除其他旧设置页面和入口。

**Architecture:** `CopisWorkingSettingsPanel` 成为唯一的设置页面宿主，菜单只保留返回对话以及上述四个迁移后的设置项；原 `SettingsPanel`、旧设置菜单和不再需要的设置页面入口全部移除。四个页面继续复用现有组件、Jotai 状态和 Electron IPC，不重复实现设置逻辑；只删除确认没有 Agent runtime、启动流程或其他生产消费者的旧设置 API。

**Tech Stack:** Bun、TypeScript、React 18、Jotai、Electron IPC/Preload、Bun Test。

---

## 0. 执行边界

### 0.1 保留并迁移到 Working 设置的页面

| Working 设置菜单 | 现有组件 | 必须保留的能力 |
|---|---|---|
| 语音输入 | `VoiceInputSettings.tsx` | 麦克风权限、语音服务配置、连接测试、全局快捷键注册 |
| 数据迁移 | `MigrationSettings.tsx` | 导入/导出迁移文件、工作区/Skills/MCP 配置迁移、文件关联导入 |
| 磁盘管理 | `StorageSettings.tsx` | 存储统计、临时文件清理、自动清理设置 |
| 外观设置 | `AppearanceSettings.tsx` | 主题、界面风格、字体/预览偏好、应用图标等已有设置 |

四个页面移动后继续使用原有组件和接口，优先通过 props 或 section wrapper 适配 Working 设置容器，不复制业务逻辑。

### 0.2 删除范围

按最新确认，删除以下 10 个 Copis 本地设置页面、菜单和对应 UI 入口：

- 通用设置 `GeneralSettings`
- 模型配置 `ChannelSettings`
- 视觉助手 `VisionRelaySettings`
- 提示词管理 `PromptSettings`
- 代理设置 `ProxySettings`
- Agent 工具 `ToolSettings`
- 远程连接 `BotHubSettings` 及其飞书、钉钉、微信设置页面
- Copis 教程设置 Tab、教程横幅和教程设置入口
- 快捷键管理 `ShortcutSettings`
- 关于/更新 `AboutSettings`

删除的是设置页面和入口。底层 Agent runtime、Working/Rust API、渠道读取、工具执行、更新检查等能力只有在确认没有其他生产消费者后才删除；不能因为对应页面删除就直接删掉 Agent 对话依赖的 API。

### 0.3 不在本计划内

- 不删除 Agent 对话、Agent 问答 Tab、Skills/MCP、技能市场、Planning、Memory、文件预览或网页 Agent。
- 不删除 `working-skill-market-api.ts`、`SkillMarketDialog.tsx` 或 `AgentSkillsView.tsx`。
- 不修改 `README.md` 和 `AGENTS.md`，除非后续获得明确允许。
- 不触碰当前工作树中 Agent Island、功能模块、Rust API 或 Task 8 的并行改动。
- 不迁移旧 Chat 数据；旧 Chat 数据继续由 `legacy-chat-cleanup.ts` 处理。

## 1. 当前事实

- Copis 本地设置入口在 `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`。
- Working 账户设置入口在 `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.tsx`。
- `AppShell.tsx` 当前同时挂载 `SettingsPanel` 和 `CopisWorkingSettingsPanel`；迁移完成后只保留后者。
- `GlobalShortcuts.tsx` 的 Cmd/Ctrl+, 设置快捷键当前打开本地设置，需要改为打开 Working 设置。
- `SDKMessageRenderer.tsx` 和 Agent 相关组件存在“前往设置”入口，当前可能指向渠道/工具设置；这些入口需要改为明确的 Working 账户设置引导，或在无法继续完成功能时显示新的可操作错误提示。
- `MigrationImportDialog.tsx` 在 `App.tsx` 全局挂载，并通过 `main/index.ts` 的文件关联事件打开；它不是本地设置菜单，迁移页面移动后必须继续保留。
- `VoiceInputSettings.tsx`、`StorageSettings.tsx`、`AppearanceSettings.tsx` 和 `MigrationSettings.tsx` 已有真实实现，不应复制或重写为 Working 专属逻辑。

## 2. 文件变更总览

### 2.1 修改

- `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.tsx`：重建菜单和 section 状态，嵌入四个迁移后的页面。
- `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.css`：为四个页面提供统一容器样式，保证原页面内容在 Working 设置窗口内可滚动。
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`：删除 `SettingsPanel` overlay，只保留 Working 设置 overlay。
- `apps/electron/src/renderer/components/shortcuts/GlobalShortcuts.tsx`：设置快捷键改为打开 Working 设置，不再打开 `settingsOpenAtom`。
- `apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx` 及仍引用 `settingsOpenAtom`/`settingsTabAtom` 的 Agent 组件：移除旧设置页导航，改为 Working 设置入口或删除失效按钮。
- `apps/electron/src/renderer/main.tsx`：移除只为本地设置面板初始化的状态；保留四个迁移页面需要的通用初始化。
- `apps/electron/src/renderer/atoms/working-atoms.ts`：增加 Working 设置当前 section 类型和 atom，或使用 Working 设置组件内部状态保持最小范围。
- `apps/electron/src/preload/index.ts`、`apps/electron/src/main/ipc.ts`、`packages/shared/src/types/*.ts`：仅删除确认无消费者的旧设置 IPC；保留四个迁移页面和 Agent runtime 所需通道。
- `apps/electron/package.json`、`packages/shared/package.json`、`bun.lock`：实现完成后按仓库规则递增受影响包 patch 版本。

### 2.2 删除

- `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- `apps/electron/src/renderer/atoms/settings-tab.ts`
- `apps/electron/src/renderer/components/settings/GeneralSettings.tsx`
- `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
- `apps/electron/src/renderer/components/settings/VisionRelaySettings.tsx`
- `apps/electron/src/renderer/components/settings/PromptSettings.tsx`
- `apps/electron/src/renderer/components/settings/ProxySettings.tsx`
- `apps/electron/src/renderer/components/settings/ToolSettings.tsx`
- `apps/electron/src/renderer/components/settings/BotHubSettings.tsx`
- `apps/electron/src/renderer/components/settings/FeishuSettings.tsx`
- `apps/electron/src/renderer/components/settings/DingTalkSettings.tsx`
- `apps/electron/src/renderer/components/settings/WeChatSettings.tsx`
- `apps/electron/src/renderer/components/settings/ShortcutSettings.tsx`
- `apps/electron/src/renderer/components/settings/AboutSettings.tsx`
- `apps/electron/src/renderer/components/tutorial/TutorialBanner.tsx`，以及只属于设置教程 Tab 的渲染分支

删除前必须先完成生产引用审计。若某个被删除页面对应的 API 仍被 Agent runtime、启动流程或其他产品模块使用，只删除页面和旧导航，不删除底层服务。

### 2.3 保留并移动

- `apps/electron/src/renderer/components/settings/VoiceInputSettings.tsx`
- `apps/electron/src/renderer/components/settings/MigrationSettings.tsx`
- `apps/electron/src/renderer/components/settings/StorageSettings.tsx`
- `apps/electron/src/renderer/components/settings/AppearanceSettings.tsx`
- `apps/electron/src/renderer/components/migration/MigrationImportDialog.tsx`
- `apps/electron/src/renderer/hooks/useMigrationImport.ts`
- `apps/electron/src/renderer/atoms/migration-atoms.ts`
- `apps/electron/src/main/lib/migration-service.ts`
- `apps/electron/src/main/lib/storage-service.ts`
- `apps/electron/src/main/lib/voice-dictation-window.ts`
- `apps/electron/src/main/lib/updater/auto-updater.ts`

### 2.4 新增测试

- `apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts`
- `apps/electron/src/renderer/components/app-shell/AppShell.settings-routing.test.tsx`
- `apps/electron/src/renderer/components/settings/settings-removal-contract.test.ts`

## Task 1: 建立迁移后的 Working 设置菜单契约

**Files:**
- Create: `apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts`
- Create: `apps/electron/src/renderer/components/settings/settings-removal-contract.test.ts`
- Read: `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- Read: `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.tsx`

- [ ] **Step 1: 写入 Working 菜单 BDD 测试。**

测试源码契约：Working 设置菜单必须包含“语音输入”“数据迁移”“磁盘管理”“外观设置”，不得包含“账户设置”“工作消息接收方式”“我的订单”“查看使用教程”；返回对话按钮可以保留为容器导航。

- [ ] **Step 2: 写入本地设置删除契约。**

测试 `SettingsPanel` 不再作为生产组件被 `AppShell` 导入，并断言旧菜单 id `general`、`channels`、`vision-relay`、`prompts`、`proxy`、`tools`、`bots`、`tutorial`、`shortcuts`、`about` 不再出现在本地设置入口。

- [ ] **Step 3: 在当前基线运行测试。**

```bash
bun test apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts apps/electron/src/renderer/components/settings/settings-removal-contract.test.ts
```

预期：实现前因旧入口仍存在而失败。

- [ ] **Step 4: 完成调用图审计。**

```bash
rg -n "SettingsPanel|settingsOpenAtom|settingsTabAtom|GeneralSettings|ChannelSettings|VisionRelaySettings|PromptSettings|ProxySettings|ToolSettings|BotHubSettings|ShortcutSettings|AboutSettings|TutorialBanner" apps/electron/src packages/shared/src
```

将每个结果归类为“仅旧设置 UI”“Agent runtime 依赖”“启动/全局快捷键依赖”或“其他产品依赖”，为后续删除范围提供依据。

## Task 2: 将四个页面嵌入 Working 账户设置

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.css`
- Keep/Adapt: `apps/electron/src/renderer/components/settings/VoiceInputSettings.tsx`
- Keep/Adapt: `apps/electron/src/renderer/components/settings/MigrationSettings.tsx`
- Keep/Adapt: `apps/electron/src/renderer/components/settings/StorageSettings.tsx`
- Keep/Adapt: `apps/electron/src/renderer/components/settings/AppearanceSettings.tsx`
- Modify: `apps/electron/src/renderer/atoms/working-atoms.ts`
- Test: `apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts`

- [ ] **Step 1: 定义 Working section 类型。**

将 `activeSection` 从 `settings | orders | messages` 改为 `voice-input | migration | storage | appearance`，菜单标签严格使用四个用户指定名称。账户信息、余额和退出登录只作为 Working 设置容器的头部/底部信息，不再作为独立菜单页。

- [ ] **Step 2: 嵌入四个既有页面。**

在 Working 主内容区按 section 渲染既有组件：

```tsx
{activeSection === 'voice-input' && <VoiceInputSettings />}
{activeSection === 'migration' && <MigrationSettings />}
{activeSection === 'storage' && <StorageSettings />}
{activeSection === 'appearance' && <AppearanceSettings />}
```

如果原页面依赖本地 `SettingsPanel` 的关闭回调或宽度约束，只增加显式 props，不复制保存和加载逻辑。

- [ ] **Step 3: 统一 Working 容器滚动和标题。**

四个页面共享 Working 设置的标题栏和内容滚动区域；不得出现嵌套不可滚动容器。迁移、存储和外观页面的按钮、Dialog、文件选择器和错误提示必须仍能在 Working 设置窗口中操作。

- [ ] **Step 4: 运行迁移后的菜单测试。**

```bash
bun test apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:renderer
```

## Task 3: 删除本地设置宿主和所有旧设置入口

**Files:**
- Delete: `apps/electron/src/renderer/components/settings/SettingsPanel.tsx`
- Delete: `apps/electron/src/renderer/atoms/settings-tab.ts`
- Modify: `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- Modify: `apps/electron/src/renderer/components/shortcuts/GlobalShortcuts.tsx`
- Modify: all files found by Task 1 that import `settingsOpenAtom` or `settingsTabAtom`
- Test: `apps/electron/src/renderer/components/app-shell/AppShell.settings-routing.test.tsx`

- [ ] **Step 1: 移除 AppShell 本地设置 overlay。**

删除 `SettingsPanel` import、`settingsOpen` 条件渲染和本地设置遮罩；Working 设置继续由 `workingSettingsOpenAtom` 控制。

- [ ] **Step 2: 迁移设置快捷键。**

Cmd/Ctrl+, 直接打开 Working 设置；删除对 `settingsOpenAtom` 和旧 `settingsTabAtom` 的写入。关闭行为仍由 Working 设置容器处理。

- [ ] **Step 3: 处理 Agent 内部旧设置导航。**

删除指向渠道、工具、提示词或关于页的旧设置按钮；如果 Agent 缺少必要配置，错误提示应指向 Working 账户设置，不得导航到已删除的本地设置 Tab。

- [ ] **Step 4: 验证唯一设置宿主。**

```bash
bun test apps/electron/src/renderer/components/app-shell/AppShell.settings-routing.test.tsx
rg -n "SettingsPanel|settingsOpenAtom|settingsTabAtom|setSettingsTab" apps/electron/src packages/shared/src
```

生产代码只允许保留已确认无 UI 入口但仍被其他运行时使用的通用设置状态；不得残留可打开旧设置页面的入口。

## Task 4: 删除其余本地设置页面

**Files:**
- Delete: `apps/electron/src/renderer/components/settings/GeneralSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/ChannelSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/VisionRelaySettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/PromptSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/ProxySettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/ToolSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/BotHubSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/FeishuSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/DingTalkSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/WeChatSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/ShortcutSettings.tsx`
- Delete: `apps/electron/src/renderer/components/settings/AboutSettings.tsx`
- Delete or modify: `apps/electron/src/renderer/components/tutorial/TutorialBanner.tsx`

- [ ] **Step 1: 分模块确认删除安全性。**

分别执行：

```bash
rg -n "ChannelSettings|ToolSettings|PromptSettings|VisionRelaySettings|ProxySettings|ShortcutSettings|AboutSettings|BotHubSettings|FeishuSettings|DingTalkSettings|WeChatSettings|TutorialBanner" apps/electron/src packages/shared/src
```

对每个结果确认它不是 Agent runtime、Rust HTTP API、技能市场、自动化、浏览器 Agent 或启动流程的必需调用方。

- [ ] **Step 2: 删除页面和仅供页面使用的渲染状态。**

删除页面文件、页面专用 atoms/hooks/CSS 和测试；保留 Agent runtime 读取配置所需的 service、配置文件和通用 IPC，除非调用图证明它们也只服务于被删除页面。

- [ ] **Step 3: 删除远程机器人设置入口。**

Bot 页面和机器人设置全部从 Working/本地设置中消失。若后台 bridge 仍自动启动或承担消息通知，先保留 bridge service，删除 UI 入口并在日志中明确它不再由设置页面管理；若无任何运行时消费者，再删除 service、IPC 和 Preload。

- [ ] **Step 4: 删除旧教程入口。**

移除教程横幅、设置教程菜单和旧教程 Tab 入口；`OnboardingView` 只保留必要的首次环境检查和进入 Agent。`MigrationImportDialog` 不得误删，它通过文件关联打开迁移流程，属于保留的“数据迁移”能力。

## Task 5: 收敛 IPC、Preload 和通用配置残留

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Modify: `apps/electron/src/main/index.ts`
- Modify: `apps/electron/src/main/lib/settings-service.ts` only where fields become truly unused
- Modify: corresponding files in `packages/shared/src/types/`
- Test: existing IPC/Preload contract tests and new settings removal contract test

- [ ] **Step 1: 清理仅服务旧页面的接口。**

删除仅被已删除本地设置页或远程机器人页面使用的 IPC/Preload 方法；不要删除语音输入、迁移、存储、外观、Working 鉴权、Agent 会话和技能市场接口。

- [ ] **Step 2: 保留迁移文件关联链路。**

继续保留 `main/index.ts` 的 `.copis-backup`、`.copis-share`、兼容 `.proma-backup`/`.proma-share` 文件识别、`MigrationImportDialog` 和 `migration-service` 导入导出接口。

- [ ] **Step 3: 审计通用 settings 字段。**

只删除没有任何生产读取/写入方的字段。保留主题、图标、语音、存储清理、Working 鉴权、Agent runtime 和技能市场所需字段；不要因删除 `GeneralSettings` 而删除用户资料或应用初始化所需的数据结构，除非调用图确认它们完全无用。

- [ ] **Step 4: 运行 IPC、Preload 和类型验证。**

```bash
bun test apps/electron/src/main/ipc.test.ts apps/electron/src/preload/index.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
```

## Task 6: 全量残留清理与版本同步

**Files:**
- Modify: affected package `package.json` files
- Modify: `bun.lock`
- Test: `apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts`
- Test: `apps/electron/src/renderer/components/settings/settings-removal-contract.test.ts`

- [ ] **Step 1: 执行页面和入口残留扫描。**

```bash
rg -n "SettingsPanel|settingsOpenAtom|settingsTabAtom|GeneralSettings|ChannelSettings|VisionRelaySettings|PromptSettings|ProxySettings|ToolSettings|BotHubSettings|ShortcutSettings|AboutSettings|教程设置|工作消息接收方式|我的订单" apps/electron/src packages/shared/src --glob '!**/*.test.*'
```

结果中不得存在这 10 个已确认删除的设置 UI；允许保留迁移四页面、Working 设置容器和必要的运行时 API。

- [ ] **Step 2: 更新受影响包版本和锁文件。**

按仓库规则递增实际修改包的 patch 版本，再运行 `bun install --lockfile-only` 同步 `bun.lock`。不得手工删除与本次无关的锁文件内容。

- [ ] **Step 3: 运行完整验证。**

```bash
bun test apps/electron/src/renderer/components/app-shell/working-settings-menu-contract.test.ts apps/electron/src/renderer/components/settings/settings-removal-contract.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
git diff --check
```

- [ ] **Step 4: 检查并行改动边界。**

确认只修改本计划涉及的设置、Working 容器、IPC/Preload 和版本文件；不回滚、不覆盖 Task 8 或其他并行 Agent 的工作树改动；确认 `README.md`、`AGENTS.md` 未变化。

## Task 7: Electron 实际窗口验收

**Files:**
- Verify: `apps/electron/src/renderer/components/app-shell/CopisWorkingSettingsPanel.tsx`
- Verify: `apps/electron/src/renderer/components/settings/VoiceInputSettings.tsx`
- Verify: `apps/electron/src/renderer/components/settings/MigrationSettings.tsx`
- Verify: `apps/electron/src/renderer/components/settings/StorageSettings.tsx`
- Verify: `apps/electron/src/renderer/components/settings/AppearanceSettings.tsx`

- [ ] **Step 1: 启动开发 Electron。**

```bash
bun run dev
```

- [ ] **Step 2: 用户确认 Working 设置菜单。**

真实 Electron 窗口中确认 Working 账户设置只显示：语音输入、数据迁移、磁盘管理、外观设置，以及返回/账户必要操作；不显示其他旧设置菜单。

- [ ] **Step 3: 用户确认四个页面功能。**

逐项确认：

1. 语音输入可以加载配置、请求麦克风权限并保存。
2. 数据迁移可以打开导入/导出流程，双击迁移文件仍能唤起导入弹窗。
3. 磁盘管理可以读取统计并执行临时文件清理。
4. 外观设置可以切换主题/界面偏好并即时生效。

- [ ] **Step 4: 用户确认 Agent 主流程。**

确认新建 Agent、模型调用、技能市场、Planning、Memory、文件预览和网页 Agent 不因设置入口清理而出现失效按钮或错误路由。

## 验收标准

- [ ] Copis 本地设置入口和 `SettingsPanel` 不再存在。
- [ ] Working 账户设置承载且只展示语音输入、数据迁移、磁盘管理、外观设置四个页面。
- [ ] 四个迁移页面继续复用原有功能和 IPC，不产生重复实现。
- [ ] 上述 10 个旧设置页面、教程入口、远程机器人设置和失效导航全部删除。
- [ ] 数据迁移文件关联导入、语音输入、存储清理和外观设置没有回归。
- [ ] Agent 对话、技能市场、Planning、Memory、文件/网页工作流没有被误删或断链。
- [ ] 没有残留指向已删除设置页面的 Renderer、Preload 或 IPC 入口。
- [ ] 自动化测试、类型检查、主进程/Preload/Renderer 构建通过。
- [ ] 用户在真实 Electron 窗口完成最终 UI 验收。
