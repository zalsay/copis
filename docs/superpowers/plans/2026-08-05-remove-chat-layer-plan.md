# 移除 Chat、仅保留 Agent 对话清理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除旧的 Chat 对话产品链路和旧 Chat 数据，只保留 Agent 会话、Agent 工具和 Agent 工作区能力；Agent 右侧问答 Tab 改为基于父 Agent 本轮之前上下文的 Agent 子会话。

**Architecture:** Renderer 只创建、恢复、搜索和展示 Agent session；TabContent 只渲染 Agent、Preview 和静态 Tutorial。Electron 主进程移除 Chat runtime、Conversation manager、Chat IPC 和 Chat preload API，并在启动早期幂等清理 ~/.copis/conversations* 以及由旧 Chat 索引明确归属的附件目录。Agent 右侧问答 Tab 保留为 Agent 子会话：从父 Agent 已持久化的本轮之前最后一条完成消息创建 Pi 分支，在子会话中展示选区和继续问答；无法安全分叉时使用 Agent 的 `mentionedSessionIds` 引用上下文兜底。所有 Agent 问答仍走现有 Pi/Rust 通道、模型选择、附件引用、文件预览、联网搜索、Nano Banana 和自定义工具配置。

**Tech Stack:** Bun、TypeScript、React 18、Jotai、Electron IPC/Preload、Pi Agent SDK、JSON/JSONL 本地存储、Bun Test。

---

## 0. 执行边界

### 0.1 用户已确认的范围

- 当前版本尚未正式发布，旧 Chat 数据不需要迁移到 Agent。
- 可以直接删除 ~/.copis/conversations.json、~/.copis/conversations/ 和旧 Chat 会话附件。
- 本次目标只保留 Agent 对话，不再提供 Chat/Agent 模式切换。
- 本轮只新增本计划文档，不修改 README.md 和 AGENTS.md。实现阶段如需要同步这两个文件，另行取得允许后再修改。

### 0.2 为什么采用一份整体验收计划

Chat UI、会话恢复、IPC、Preload 和本地数据彼此有直接依赖，单独删除任一层都会留下可点击但失效的入口或启动时重新创建 Chat 目录。本计划按共享类型、数据清理、Renderer 入口、Agent 侧面板、主进程 IPC、工具配置和最终验证分 Task，但以同一个 Agent-only 不变量做整体验收。

### 0.3 当前事实

- 当前主界面由 apps/electron/src/renderer/components/app-shell/AppShell.tsx、MainArea.tsx 和 CopisWorkingSidebar.tsx 组成，但 MainArea、Tab 恢复、搜索、快捷键和系统托盘仍保留 Chat 分支。
- Chat runtime 在 apps/electron/src/main/lib/chat-service.ts，持久化在 apps/electron/src/main/lib/conversation-manager.ts，Chat IPC handler 集中在 apps/electron/src/main/ipc.ts，Preload 暴露在 apps/electron/src/preload/index.ts。
- Agent 已经有独立的 agent-session-manager.ts、agent-service.ts、agent-orchestrator.ts、AgentView.tsx 和 Agent IPC，不需要把 Chat 逻辑改造成新的 Agent runtime。
- AgentHistorySelectionLayer.tsx、DiffTabContent.tsx 和 SidePanel.tsx 还会创建右侧 Chat 问答 Tab；这些入口必须改成 Agent 问答子会话，不能继续创建 Chat conversation。
- ModelSelector.tsx、AttachmentPreviewItem.tsx、CopyButton.tsx、UserAvatar.tsx 和 formatMessageTime 虽然位于 components/chat/，但被 Agent、设置页、预览页或欢迎页复用，不能随旧 Chat 目录直接删除。

### 0.4 明确保留的 Agent 能力

- apps/electron/src/main/lib/adapters/pi-agent-adapter.ts、agent-orchestrator.ts、agent-session-manager.ts、Agent IPC 和 Rust HTTP/SSE 通道。
- Agent 工作区、会话 JSONL、MCP、Skills、Planning、Memory、文件树、文件预览和工作区附件。
- ModelSelector 的 Agent/自动化/视觉助手场景。
- apps/electron/src/main/lib/web-search-service.ts、内置 MCP 的联网搜索、Nano Banana 和自定义 HTTP 工具配置。它们存在 chat-tool-* 历史命名，但属于 Agent 工具配置或内置工具依赖，不能按名称误删。
- attachment-service.ts 中被 Agent 文件选择、视觉助手或 Nano Banana 使用的通用能力。清理旧 Chat 数据时不能递归删除整个 attachments/ 根目录。

### 0.5 目标不变量

1. AppMode 运行时只有 agent；旧 localStorage 值 chat 启动后规范化为 agent。
2. TabType 只允许 agent、preview、tutorial；旧持久化 Chat Tab 被丢弃，不参与恢复和保存。
3. 新建、搜索、切换、快捷键、托盘和 onboarding 都只能产生或打开 Agent session。
4. TabContent 生产代码中不再导入或渲染 ChatView。
5. Renderer、Preload、主进程和 @copis/shared 不再暴露 Chat 会话 CRUD、Chat 流式事件、Chat 发送或 Chat -> Agent 迁移 API。
6. 启动清理是幂等的：旧数据存在、旧数据不存在、重复启动和清理失败重试都不会破坏 Agent session/workspace。
7. Agent 仍能完成创建会话、流式输出、权限请求、模型切换、附件引用、文件预览、搜索 Agent 历史和运行 Agent 内置工具。
8. AgentSidePanelTab 保留 `files`、`changes`、`qa`；`qa` 永远渲染 Agent 问答子会话，不渲染 ChatView 或 Chat atoms。
9. Agent 问答子会话首次创建时只从父 Agent 已持久化的本轮之前上下文开始：优先 fork 到最近一条有 Pi entry binding 的完成 assistant 消息，再把选中文本作为子 Agent 的引用；无法安全 fork 时创建普通 Agent 子会话并通过 `mentionedSessionIds` 注入父会话上下文，不能静默丢失上下文。

## 1. 数据清理策略

新增 apps/electron/src/main/lib/legacy-chat-cleanup.ts，由主进程启动流程调用。清理服务只操作以下路径：

~~~text
<configDir>/conversations.json
<configDir>/conversations/
<configDir>/attachments/<legacyConversationId>/
~~~

清理顺序固定为：

1. 在删除索引前读取 conversations.json，提取其中合法的 Chat conversation ID。
2. 删除 conversations.json 和 conversations/，使用 rmSync(..., { recursive: true, force: true }) 保证幂等。
3. 只删除 attachments/<legacyConversationId>/，不删除 attachments/ 根目录及不在旧 Chat 索引中的目录。
4. 不触碰 agent-sessions.json、agent-sessions/、agent-workspaces.json、agent-workspaces/、sdk-config/、memory/、chat-tools.json 或 Planning 数据。
5. 记录中文启动日志，包括发现的旧 conversation 数量和实际删除结果；单次失败交给现有 safeRun 记录，不阻止窗口创建。

清理服务不得调用会自动创建目录的 getConversationsDir()；测试和正式运行都应直接组合路径，避免清理后又创建空的 Chat 目录。

## 2. 文件变更总览

### 2.1 新增

- apps/electron/src/main/lib/legacy-chat-cleanup.ts：旧 Chat 数据清理服务。
- apps/electron/src/main/lib/legacy-chat-cleanup.test.ts：清理服务 BDD 测试。
- packages/shared/src/types/attachments.ts：从旧 chat.ts 抽出的通用附件、文件选择和附件保存类型。
- packages/shared/src/types/model.ts：从旧 chat.ts 抽出的 ModelOption。
- apps/electron/src/renderer/atoms/model-atoms.ts：Agent、设置、自动化和视觉助手共用的渠道/模型 Jotai atoms。
- apps/electron/src/renderer/atoms/app-mode.test.ts：旧模式值规范化测试。
- apps/electron/src/renderer/components/model/ModelSelector.tsx：从 Chat 目录移出的通用模型选择器。
- apps/electron/src/renderer/components/model/model-selector-utils.ts：通用模型选项构建函数。
- apps/electron/src/renderer/components/attachments/AttachmentPreviewItem.tsx：Agent Composer 使用的附件预览。
- apps/electron/src/renderer/components/profile/UserAvatar.tsx：设置、会话预览和 Agent 相关页面共用的用户头像。
- apps/electron/src/renderer/components/message/CopyButton.tsx：Agent SDK 消息使用的复制按钮。
- apps/electron/src/renderer/components/message/message-format.ts：Agent 消息时间格式化函数。
- apps/electron/src/renderer/components/agent/AgentQuestionView.tsx：右侧 Agent 问答子会话的紧凑视图，复用 Agent 消息、权限和 Composer 能力。
- apps/electron/src/renderer/hooks/useOpenAgentQuestion.ts：从历史/文件选区创建或复用 Agent 问答子会话的统一入口。
- apps/electron/src/renderer/lib/agent-side-question.ts：计算本轮之前的安全 fork 点并构建 Agent 问答引用提示词的纯函数。
- apps/electron/src/renderer/components/agent/AgentQuestionView.test.tsx、apps/electron/src/renderer/lib/agent-side-question.test.ts：Agent 问答上下文和侧面板渲染测试。
- apps/electron/src/renderer/components/tabs/tab-restore.test.ts：Agent-only 启动恢复测试。
- apps/electron/src/renderer/components/app-shell/SearchDialog.test.tsx：Agent-only 搜索测试。
- apps/electron/src/renderer/components/selection/SelectionActionPopover.test.tsx：选区引用测试。
- apps/electron/src/main/lib/tray-menu-model.test.ts：Agent-only 托盘菜单测试。
- apps/electron/src/main/lib/builtin-mcp/catalog.test.ts：Agent 内置工具可用性测试。
- apps/electron/src/main/lib/agent-tool-config.test.ts：Agent 工具配置读写测试。
- apps/electron/src/preload/index.test.ts、apps/electron/src/main/ipc.test.ts：Preload/IPC contract 测试。

### 2.2 修改

- packages/shared/src/types/index.ts、packages/shared/src/index.ts、packages/shared/src/types/agent.ts：收缩共享类型和 Agent IPC，去掉 Chat 类型/迁移通道，导出通用附件/模型类型。
- apps/electron/src/renderer/atoms/app-mode.ts、tab-atoms.ts、tab-atoms.test.ts、agent-atoms.ts、atoms/index.ts：只保留 Agent Tab 和 Agent 模式。
- apps/electron/src/renderer/App.tsx、main.tsx：onboarding、启动恢复、全局初始化和持久化只面向 Agent。
- apps/electron/src/renderer/components/tabs/TabContent.tsx、TabBar.tsx、TabBarItem.tsx、TabSwitcher.tsx、MainArea.tsx：删除 Chat 分支和 Chat 候选。
- apps/electron/src/renderer/components/welcome/WelcomeView.tsx、WelcomeComposer.tsx：欢迎页只创建 Agent draft/session。
- apps/electron/src/renderer/components/app-shell/AppShell.tsx、SearchDialog.tsx、CopisWorkingSidebar.tsx：搜索只查找 Agent session；搜索语义 prompt 只引用 Agent JSONL。
- apps/electron/src/renderer/components/shortcuts/GlobalShortcuts.tsx、lib/shortcut-defaults.ts：新建、快速任务和快捷键只走 Agent。
- apps/electron/src/renderer/atoms/agent-atoms.ts、preview-atoms.ts：将右侧 Tab 改为 `files`/`changes`/`qa`，增加父 Agent 到问答子会话的 Jotai 映射，保留 Agent 文件/引用状态。
- apps/electron/src/renderer/components/agent/AgentHistorySelectionLayer.tsx、AgentQuestionView.tsx、AgentView.tsx、SidePanel.tsx、SDKMessageRenderer.tsx：移除 Chat 依赖，保留 Agent 问答子会话、引用、模型和消息能力。
- apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx、DiffTabContent.tsx、components/selection/SelectionActionPopover.tsx：保留并重命名 Agent 问答 Tab，选区可引用到当前 Agent 或打开 Agent 问答子会话。
- apps/electron/src/main/lib/agent-session-manager.ts、agent-session-manager.test.ts、apps/electron/src/main/ipc.ts、apps/electron/src/preload/index.ts、packages/shared/src/types/agent.ts：增加创建 Agent 问答子会话的 typed IPC；Pi 分叉继承父 Agent 截止到指定完成消息的上下文，并标记 `parentSessionId`/`archived`。
- apps/electron/src/renderer/components/session-preview/SessionMiniMapPopover.tsx、tabs/TabPreviewPanel.tsx、ai-elements/scroll-minimap.tsx：只处理 Agent session 和通用消息预览。
- apps/electron/src/renderer/components/settings/GeneralSettings.tsx、ChannelSettings.tsx、ToolSettings.tsx、VisionRelaySettings.tsx、automation/AutomationFormView.tsx：更新通用类型和模型/工具命名。
- apps/electron/src/renderer/hooks/useCreateSession.ts、useOpenSession.ts、useCloseTab.tsx、useSyncActiveTabSideEffects.ts、useGlobalAgentListeners.ts：移除 Chat 状态同步。
- apps/electron/src/renderer/contexts/session-context.tsx：只保留 AgentSessionContext；删除 ConversationContext。
- apps/electron/src/renderer/lib/http-api-bridge.ts：移除 Chat API fallback，只保留 Agent、Tutorial 和其他现存模块 API。
- apps/electron/src/main/index.ts、main/tray.ts、main/lib/tray-menu-model.ts：托盘只保留 Agent 会话入口，启动和退出不再管理 Chat generation。
- apps/electron/src/main/ipc.ts、apps/electron/src/preload/index.ts：删除 Chat IPC；将 Agent 仍需的附件/文件选择/教程能力迁移到通用或 Agent 通道。
- apps/electron/src/main/lib/agent-session-manager.ts、agent-session-manager.test.ts：删除 Chat 会话读取和 migrateChatToAgentSession。
- apps/electron/src/main/lib/migration-service.ts、storage-service.ts、config-paths.ts：移除 Chat 导出/导入/清理分类，保留 Agent 数据和通用工具配置。
- apps/electron/src/main/lib/tutorial-service.ts、http-api-handler.ts：教程只返回静态内容，不创建 Chat 欢迎对话。
- apps/electron/src/main/lib/chat-tool-config.ts、chat-tool-registry.ts、chat-tools-watcher.ts、chat-tools/、packages/shared/src/types/chat-tool.ts、renderer/atoms/chat-tool-atoms.ts、settings/ToolSettings.tsx：将仍被 Agent 使用的工具配置归类为 Agent 工具；删除仅用于 Chat 模式切换的 agent-recommend 分支。
- apps/electron/package.json、packages/shared/package.json、bun.lock：实现完成后按仓库规则递增受影响包的 patch 版本。

### 2.3 删除

- apps/electron/src/main/lib/chat-service.ts
- apps/electron/src/main/lib/conversation-manager.ts
- apps/electron/src/main/lib/chat-tool-executor.ts，前提是静态审计确认没有 Agent 调用方
- apps/electron/src/main/lib/chat-tools/agent-recommend-tool.ts
- apps/electron/src/renderer/hooks/useGlobalChatListeners.ts
- apps/electron/src/renderer/hooks/useConversationSettings.ts
- apps/electron/src/renderer/atoms/chat-atoms.ts
- apps/electron/src/renderer/components/chat/ChatView.tsx
- apps/electron/src/renderer/components/chat/ChatHeader.tsx
- apps/electron/src/renderer/components/chat/ChatInput.tsx
- apps/electron/src/renderer/components/chat/ChatMessages.tsx
- apps/electron/src/renderer/components/chat/ChatMessageItem.tsx
- apps/electron/src/renderer/components/chat/ParallelChatMessages.tsx
- apps/electron/src/renderer/components/chat/ContextSettingsPopover.tsx
- apps/electron/src/renderer/components/chat/SystemPromptSelector.tsx
- apps/electron/src/renderer/components/chat/ToolSelectorPopover.tsx
- apps/electron/src/renderer/components/chat/ChatToolActivityIndicator.tsx
- apps/electron/src/renderer/components/chat/ChatToolBlock.tsx
- apps/electron/src/renderer/components/chat/AgentRecommendBanner.tsx
- apps/electron/src/renderer/components/chat/MigrateToAgentButton.tsx
- apps/electron/src/renderer/components/chat/InlineEditForm.tsx
- apps/electron/src/renderer/components/chat/DeleteMessageDialog.tsx
- apps/electron/src/renderer/components/chat/ClearContextButton.tsx
- apps/electron/src/renderer/components/chat/PromptEditorSidebar.tsx
- apps/electron/src/renderer/components/chat/index.ts
- apps/electron/src/renderer/components/app-shell/ModeSwitcher.tsx
- apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx，仅在静态引用确认当前 AppShell 无生产依赖后删除
- packages/shared/src/types/chat.ts

---

## Task 1: 收缩共享类型和 Jotai 状态

**Files:**

- Create: packages/shared/src/types/attachments.ts
- Create: packages/shared/src/types/model.ts
- Create: apps/electron/src/renderer/atoms/model-atoms.ts
- Create: apps/electron/src/renderer/atoms/app-mode.test.ts
- Modify: packages/shared/src/types/index.ts、packages/shared/src/index.ts、packages/shared/src/types/agent.ts
- Modify: apps/electron/src/renderer/atoms/app-mode.ts、tab-atoms.ts、tab-atoms.test.ts、agent-atoms.ts、atoms/index.ts
- Modify: 当前所有导入 FileAttachment、FileDialogResult、FileDialogLargeFile、ModelOption、channelsAtom、selectedModelAtom、modelSelectorOpenAtom 的文件
- Delete after imports are migrated: apps/electron/src/renderer/atoms/chat-atoms.ts、packages/shared/src/types/chat.ts

- [ ] **Step 1: 写失败测试，锁定旧模式和旧 Tab 的清理行为。**

~~~ts
import { describe, expect, test } from 'bun:test'
import { normalizeAppMode } from './app-mode'
import { sanitizePersistedTabs } from './tab-atoms'

describe('仅 Agent 模式', () => {
  test('旧 localStorage 值 chat 规范化为 agent', () => {
    expect(normalizeAppMode('chat')).toBe('agent')
    expect(normalizeAppMode('agent')).toBe('agent')
    expect(normalizeAppMode(undefined)).toBe('agent')
  })

  test('持久化状态丢弃 Chat Tab，并保留有效 Agent Tab', () => {
    const result = sanitizePersistedTabs([
      { id: 'chat-1', type: 'chat', sessionId: 'chat-1', title: '旧 Chat' },
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' },
      { id: '__preview__:agent-1', type: 'preview', sessionId: 'agent-1', title: '预览' },
    ], new Set(['agent-1']))

    expect(result).toEqual([
      { id: 'agent-1', type: 'agent', sessionId: 'agent-1', title: 'Agent' },
    ])
  })
})
~~~

实现阶段在 tab-atoms.ts 暴露 sanitizePersistedTabs(value: unknown, validSessionIds: ReadonlySet<string>)，由恢复边界负责解析旧对象；测试目标是验证解析和过滤，而不是绕过 TypeScript。

- [ ] **Step 2: 运行失败测试，确认当前实现仍接受 Chat。**

~~~bash
bun test apps/electron/src/renderer/atoms/app-mode.test.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts
~~~

Expected: 新增的 normalizeAppMode 不存在，或旧 getPersistableTabState 仍返回 Chat Tab，测试失败。

- [ ] **Step 3: 抽出共享附件和模型类型。**

将以下类型从 packages/shared/src/types/chat.ts 移到新文件，保持字段名和运行时协议不变：

~~~ts
// packages/shared/src/types/attachments.ts
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024

export interface FileAttachment {
  id: string
  filename: string
  mediaType: string
  localPath: string
  size: number
}

export interface AttachmentSaveInput {
  conversationId: string
  filename: string
  mediaType: string
  data: string
}

export interface AttachmentSaveResult {
  attachment: FileAttachment
}

export interface FileDialogFile {
  filename: string
  mediaType: string
  data: string
  size: number
}

export interface FileDialogLargeFile {
  filename: string
  mediaType: string
  size: number
  path: string
}

export interface FileDialogSkippedFile {
  filename: string
  mediaType?: string
  size?: number
  path?: string
  reason: 'unreadable'
  message?: string
}

export interface FileDialogDirectory {
  name: string
  path: string
}

export interface FileDialogResult {
  files: FileDialogFile[]
  largeFiles?: FileDialogLargeFile[]
  skippedFiles?: FileDialogSkippedFile[]
}

export interface FileOrFolderDialogResult extends FileDialogResult {
  directories: FileDialogDirectory[]
}
~~~

将 ModelOption 移到 packages/shared/src/types/model.ts，在 types/index.ts 和 packages/shared/src/index.ts 继续导出；packages/shared/src/types/agent.ts 只删除 MIGRATE_CHAT_TO_AGENT，不改变 Agent session DTO。

- [ ] **Step 4: 建立 Agent/通用模型 atoms，删除 Chat 专属 atoms。**

apps/electron/src/renderer/atoms/model-atoms.ts 至少提供以下公开 atom，所有状态继续使用 Jotai：

~~~ts
export interface SelectedModel {
  channelId: string
  modelId: string
}

export const channelsAtom = atom<Channel[]>([])
export const channelsLoadedAtom = atom(false)
export const selectedModelAtom = atomWithStorage<SelectedModel | null>('copis-selected-model', null)
export const modelSelectorOpenAtom = atom(false)
~~~

从 chat-atoms.ts 移除 conversationsAtom、currentConversationIdAtom、Chat 流式 Map、Chat 草稿、Chat 上下文、agentSideChatMapAtom 和 pendingAgentRecommendationAtom。Agent 自己的会话/运行状态留在 agent-atoms.ts；渠道和模型引用改为从 model-atoms.ts 导入。

- [ ] **Step 5: 让 AppMode 和 Tab 类型在类型层面拒绝 Chat。**

目标代码形状：

~~~ts
export type AppMode = 'agent'

export function normalizeAppMode(_value: unknown): AppMode {
  return 'agent'
}

export type TabType = 'agent' | 'preview' | 'tutorial'
~~~

tab-atoms.ts 中 tabStreamingMapAtom、tabIndicatorMapAtom、isSessionTab、getPersistableTabState 和 openTab 删除 Chat 分支；新增 sanitizePersistedTabs 负责从 unknown 解析旧对象，不能使用类型断言把 chat 伪装成 Agent。

- [ ] **Step 6: 运行测试和类型检查。**

~~~bash
bun test apps/electron/src/renderer/atoms/app-mode.test.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts
bun run typecheck
~~~

Expected: 模式/Tab 测试 PASS；如果类型检查因尚未完成的下游导入迁移失败，错误只能集中在本计划列出的 Chat consumer，不能新增未列出的跨层依赖。

- [ ] **Step 7: 提交类型和状态边界。**

~~~bash
git add packages/shared/src/types apps/electron/src/renderer/atoms
git commit -m "refactor: make agent the only conversation mode"
~~~

## Task 2: 实现旧 Chat 数据的幂等清理

**Files:**

- Create: apps/electron/src/main/lib/legacy-chat-cleanup.ts
- Create: apps/electron/src/main/lib/legacy-chat-cleanup.test.ts
- Modify: apps/electron/src/main/index.ts

- [ ] **Step 1: 写清理服务的失败测试。**

测试使用临时目录注入 configDir，不读真实用户目录：

~~~ts
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { cleanupLegacyChatData } from './legacy-chat-cleanup'

describe('legacy Chat 数据清理', () => {
  test('删除旧 Chat 索引、消息和按旧 conversation ID 归属的附件', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'copis-chat-cleanup-'))
    writeFileSync(join(configDir, 'conversations.json'), JSON.stringify({
      version: 1,
      conversations: [{ id: 'legacy-1' }, { id: 'legacy-2' }],
    }))
    mkdirSync(join(configDir, 'conversations'), { recursive: true })
    writeFileSync(join(configDir, 'conversations', 'legacy-1.jsonl'), '{}\n')
    mkdirSync(join(configDir, 'attachments', 'legacy-1'), { recursive: true })
    mkdirSync(join(configDir, 'attachments', 'agent-session-1'), { recursive: true })
    mkdirSync(join(configDir, 'agent-sessions'), { recursive: true })
    writeFileSync(join(configDir, 'agent-sessions', 'agent-session-1.jsonl'), '{}\n')

    const result = cleanupLegacyChatData(configDir)

    expect(result.conversationIds).toEqual(['legacy-1', 'legacy-2'])
    expect(existsSync(join(configDir, 'conversations.json'))).toBe(false)
    expect(existsSync(join(configDir, 'conversations'))).toBe(false)
    expect(existsSync(join(configDir, 'attachments', 'legacy-1'))).toBe(false)
    expect(existsSync(join(configDir, 'attachments', 'agent-session-1'))).toBe(true)
    expect(existsSync(join(configDir, 'agent-sessions', 'agent-session-1.jsonl'))).toBe(true)
  })

  test('没有旧数据和重复执行都正常通过', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'copis-chat-cleanup-'))
    expect(() => cleanupLegacyChatData(configDir)).not.toThrow()
    expect(() => cleanupLegacyChatData(configDir)).not.toThrow()
  })
})
~~~

- [ ] **Step 2: 运行测试确认服务尚未实现。**

~~~bash
bun test apps/electron/src/main/lib/legacy-chat-cleanup.test.ts
~~~

Expected: 因 legacy-chat-cleanup.ts 不存在或清理结果不符合预期而 FAIL。

- [ ] **Step 3: 实现可注入、幂等且不误删 Agent 的清理服务。**

公开接口保持以下形状：

~~~ts
export interface LegacyChatCleanupResult {
  conversationIds: string[]
  removedConversationIndex: boolean
  removedConversationDirectory: boolean
  removedAttachmentDirectories: string[]
}

export function cleanupLegacyChatData(configDir = getConfigDir()): LegacyChatCleanupResult
~~~

实现要求：

- 只在索引文件存在且 JSON 结构为对象时读取 conversations 数组；非法条目忽略并记录中文警告。
- 只接受不包含路径分隔符和 .. 的非空 ID，避免旧文件损坏时形成路径穿越。
- 删除时使用 rmSync 的 force: true，空目录、缺失文件和重复执行都不报错。
- 不调用 getConversationsDir()、getConversationMessagesPath() 或会自动创建目录的 getter。
- 只删除 attachments/<legacy ID>，不删除根目录和其他 ID 目录。

- [ ] **Step 4: 在主进程启动早期调用清理。**

修改 apps/electron/src/main/index.ts 的 bootstrap()，在 ensureDefaultWorkspace()、registerIpcHandlers() 之前加入：

~~~ts
safeRun('cleanupLegacyChatData', cleanupLegacyChatData)
~~~

导入只来自 ./lib/legacy-chat-cleanup。清理异常由 safeRun 记录，不阻断 Agent 窗口启动。

- [ ] **Step 5: 运行清理测试和主进程构建。**

~~~bash
bun test apps/electron/src/main/lib/legacy-chat-cleanup.test.ts
bun run --filter='@copis/electron' build:main
~~~

Expected: 清理测试 PASS；dist/main.cjs 构建成功。

- [ ] **Step 6: 提交数据清理边界。**

~~~bash
git add apps/electron/src/main/lib/legacy-chat-cleanup.ts apps/electron/src/main/lib/legacy-chat-cleanup.test.ts apps/electron/src/main/index.ts
git commit -m "feat: remove legacy chat data on startup"
~~~

## Task 3: 启动恢复和 Agent 会话生命周期只保留 Agent

**Files:**

- Modify: apps/electron/src/renderer/App.tsx
- Modify: apps/electron/src/renderer/main.tsx
- Modify: apps/electron/src/renderer/components/welcome/WelcomeView.tsx
- Modify: apps/electron/src/renderer/components/welcome/WelcomeComposer.tsx
- Modify: apps/electron/src/renderer/components/tabs/TabContent.tsx
- Modify: apps/electron/src/renderer/components/tabs/TabBar.tsx
- Modify: apps/electron/src/renderer/components/tabs/TabBarItem.tsx
- Modify: apps/electron/src/renderer/components/tabs/TabSwitcher.tsx
- Modify: apps/electron/src/renderer/hooks/useCreateSession.ts
- Modify: apps/electron/src/renderer/hooks/useOpenSession.ts
- Modify: apps/electron/src/renderer/hooks/useCloseTab.tsx
- Modify: apps/electron/src/renderer/hooks/useSyncActiveTabSideEffects.ts
- Modify: apps/electron/src/renderer/atoms/tab-atoms.ts、tab-atoms.test.ts
- Test: apps/electron/src/renderer/components/tabs/tab-restore.test.ts

- [ ] **Step 1: 写启动恢复和欢迎页的 BDD 测试。**

~~~text
Given settings.tabState 中包含旧 Chat Tab，且 agent-sessions.json 中有可用 Agent session
When TabStatePersistenceInitializer 恢复标签
Then 旧 Chat Tab 被丢弃，最近 Agent session 成为 active tab，appMode 为 agent

Given 用户完成 onboarding 且没有选择打开静态教程
When 应用创建欢迎会话
Then 只调用 createAgentSession，打开 type=agent 的 draft/session，不调用 createConversation API

Given tabs 为空
When WelcomeView 初始化
Then 只创建 Agent draft，等待 agentSettingsReady，不读取 conversations.json
~~~

测试中的 Electron API 使用显式类型化 mock，不使用 any。

- [ ] **Step 2: 运行测试确认现有 Chat 分支失败。**

~~~bash
bun test apps/electron/src/renderer/components/tabs/tab-restore.test.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts
~~~

Expected: 当前恢复逻辑仍调用 listConversations() 或恢复 type: chat，新测试 FAIL。

- [ ] **Step 3: 收缩 TabStatePersistenceInitializer。**

在 apps/electron/src/renderer/main.tsx 中：

- Promise.all 删除 window.electronAPI.listConversations()，只读取 getSettings() 和 listAgentSessions()。
- validTabs 只接受 type === agent，预览 Tab 由 Agent session 恢复逻辑重建，不把 Chat 当成有效会话。
- fallback 只选择未归档 Agent session；没有 Agent session 时保持空列表，让 WelcomeView 创建 Agent draft。
- 从 activeTab 同步时只设置 Agent atoms；移除 currentConversationIdAtom 和 setAppMode('chat')。
- 启动时调用 normalizeAppMode(store.get(appModeAtom))，结果始终为 agent。

目标恢复片段：

~~~ts
const validTabs = tabState?.tabs?.filter(
  (tab): tab is TabItem => isPersistedAgentTab(tab) && validSessionIds.has(tab.sessionId),
) ?? []

const recentAgent = sortByUpdatedAt(agentSessions.filter((session) => !session.archived))[0]
const tabsToRestore = validTabs.length > 0
  ? validTabs
  : recentAgent
    ? [{ id: recentAgent.id, type: 'agent' as const, sessionId: recentAgent.id, title: recentAgent.title }]
    : []
~~~

- [ ] **Step 4: 让欢迎页和 onboarding 只走 Agent。**

在 App.tsx 中删除 conversationsAtom、createWelcomeConversation() 和 type: chat。完成 onboarding 后：

- openTutorial === true 仍打开静态 tutorial Tab。
- 其他情况调用 window.electronAPI.createAgentSession() 或 useCreateSession().createAgent()，使用当前 Agent workspace/settings，打开 type: agent。
- 不再调用 tutorial-service.createWelcomeConversation()。

在 WelcomeView.tsx 中删除 appModeAtom、createChat 和 listConversations() 分支；只等待 Agent settings，然后复用最近 Agent session 或创建 Agent draft。

- [ ] **Step 5: 删除 Tab 内容和会话切换中的 Chat 分支。**

TabContent.tsx 删除 ChatView import 和 if (tab.type === chat) 分支。TabBar.tsx、TabSwitcher.tsx、useOpenSession.ts、useSyncActiveTabSideEffects.ts、useCloseTab.tsx 删除 Chat 状态写入；所有 session 导航只接受 agent，预览继续绑定 Agent session。

TabSwitcher.tsx 的候选模型只从 agentSessionsAtom 构造，删除 conversationsAtom、streamingConversationIdsAtom、ConversationMeta 和 Chat 图标。

- [ ] **Step 6: 运行生命周期测试、类型检查和 Renderer 构建。**

~~~bash
bun test apps/electron/src/renderer/components/tabs/tab-restore.test.ts apps/electron/src/renderer/atoms/app-mode.test.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:renderer
~~~

Expected: 恢复/欢迎测试 PASS；Renderer 构建成功；错误只能来自尚未处理的 Chat IPC/组件入口。

- [ ] **Step 7: 提交 Agent-only 生命周期。**

~~~bash
git add apps/electron/src/renderer/App.tsx apps/electron/src/renderer/main.tsx apps/electron/src/renderer/components/tabs apps/electron/src/renderer/components/welcome apps/electron/src/renderer/hooks apps/electron/src/renderer/atoms
git commit -m "refactor: restore and create agent sessions only"
~~~

## Task 4: 清理搜索、快捷键和系统托盘入口

**Files:**

- Modify: apps/electron/src/renderer/components/app-shell/AppShell.tsx、CopisWorkingSidebar.tsx、SearchDialog.tsx
- Modify: apps/electron/src/renderer/components/shortcuts/GlobalShortcuts.tsx、renderer/lib/shortcut-defaults.ts
- Modify: apps/electron/src/main/tray.ts、main/index.ts、main/lib/tray-menu-model.ts
- Create: apps/electron/src/renderer/components/app-shell/SearchDialog.test.tsx、apps/electron/src/main/lib/tray-menu-model.test.ts

- [ ] **Step 1: 写 Agent-only 搜索和入口测试。**

~~~text
Given 搜索词匹配 Agent 标题和旧 Chat 标题
When 执行搜索
Then 结果只包含 Agent，且内容搜索只调用 searchAgentSessionMessages

Given 搜索语义任务需要创建一个搜索 Agent
When 点击 Agent 搜索
Then prompt 只包含 agent-sessions 路径，不提 conversations 路径

Given 托盘菜单包含最近会话和新建入口
When 构造菜单模型
Then 没有“新建对话”，只有“新建 Agent 会话”和 Agent 最近会话
~~~

快捷键测试断言 Cmd/Ctrl+N、快速任务提交、托盘 CREATE_SESSION 数据都使用 mode: agent 或直接 Agent API；切换 Chat/Agent 的快捷键不再注册。

- [ ] **Step 2: 运行测试确认当前实现失败。**

~~~bash
bun test apps/electron/src/renderer/components/app-shell/SearchDialog.test.tsx apps/electron/src/main/lib/tray-menu-model.test.ts
~~~

Expected: 当前搜索结果包含 Chat、搜索 prompt 包含 conversations/，或托盘仍有“新建对话”，测试 FAIL。

- [ ] **Step 3: 改造 SearchDialog 为 Agent-only。**

删除 conversationsAtom、MessageSearchResult、ConversationMeta 和 type: chat；标题结果只从 agentSessionsAtom 过滤，内容结果只使用 searchAgentSessionMessages()。SearchResult、SessionMiniMapTarget 和导航回调的 type 改为 agent，打开结果统一调用 openSession('agent', ...)。

语义搜索 prompt 只保留：

~~~text
请帮我在 Copis 的 Agent 会话历史中搜索与以下描述相关的内容：
<query>

搜索范围：~/.copis/agent-sessions/ 目录下所有 .jsonl 文件
~~~

保留 workspace badge、迷你地图、归档标记和键盘导航。

- [ ] **Step 4: 改造快捷键和快速任务。**

在 GlobalShortcuts.tsx 中：

- Cmd/Ctrl+N 直接 createAgent({ draft: true })。
- 删除 appMode === chat 判断、Chat/Agent 切换快捷键和 Chat current conversation 状态。
- 快速任务窗口保存附件时继续使用通用 saveAttachment，提交后创建 Agent session 并写入 Agent pending prompt；不得把附件绑定到 Chat conversation。
- 收到托盘 CREATE_SESSION 时忽略旧的 chat mode，统一创建 Agent。

在 shortcut-defaults.ts 中移除 Chat 模式切换说明和“新建对话”文案，保留 Agent 新建/停止/搜索/规划快捷键。

- [ ] **Step 5: 改造系统托盘。**

TrayActions 删除 createChatSession；托盘模板删除“新建对话”，保留“新建 Agent 会话”。main/index.ts 的 createTray callback 只发送 mode: agent 或统一的 Agent 创建通道。tray-menu-model.ts 继续只从 listAgentSessions() 生成运行中/最近/更多列表。

- [ ] **Step 6: 运行入口测试和 Renderer 构建。**

~~~bash
bun test apps/electron/src/renderer/components/app-shell/SearchDialog.test.tsx apps/electron/src/main/lib/tray-menu-model.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:renderer
~~~

Expected: 搜索、快捷键和托盘测试 PASS；构建产物中不再包含 Chat 搜索和新建入口。

- [ ] **Step 7: 提交入口清理。**

~~~bash
git add apps/electron/src/renderer/components/app-shell apps/electron/src/renderer/components/shortcuts apps/electron/src/renderer/lib/shortcut-defaults.ts apps/electron/src/main/tray.ts apps/electron/src/main/index.ts apps/electron/src/main/lib/tray-menu-model.ts
git commit -m "refactor: remove chat entry points"
~~~

## Task 5: 保留 Agent 右侧问答 Tab，基于父 Agent 本轮之前上下文创建 Agent 子会话

**Files:**

- Modify: packages/shared/src/types/agent.ts
- Modify: apps/electron/src/main/lib/agent-session-manager.ts、agent-session-manager.test.ts
- Modify: apps/electron/src/main/ipc.ts、apps/electron/src/preload/index.ts
- Modify: apps/electron/src/renderer/atoms/agent-atoms.ts、preview-atoms.ts
- Create: apps/electron/src/renderer/components/agent/AgentQuestionView.tsx、AgentQuestionView.test.tsx
- Modify: apps/electron/src/renderer/components/agent/AgentView.tsx、AgentHistorySelectionLayer.tsx、SidePanel.tsx
- Modify: apps/electron/src/renderer/components/diff/DiffPanelTabBar.tsx、DiffTabContent.tsx
- Modify: apps/electron/src/renderer/components/selection/SelectionActionPopover.tsx
- Create: apps/electron/src/renderer/hooks/useOpenAgentQuestion.ts
- Create: apps/electron/src/renderer/lib/agent-side-question.ts、agent-side-question.test.ts
- Modify: apps/electron/src/renderer/hooks/useFocusAgentSessionInput.ts、useCloseTab.tsx
- Create: apps/electron/src/renderer/components/selection/SelectionActionPopover.test.tsx

- [ ] **Step 1: 写上下文边界、IPC 合约和选区行为的失败测试。**

先增加纯函数和 contract 测试，锁定“本轮之前”不能读取流式中的未完成消息，也不能回到 Chat：

~~~ts
import { describe, expect, test } from 'bun:test'
import { findPreviousCompletedAssistantUuid, buildAgentSideQuestionPrompt } from './agent-side-question'

describe('Agent 侧问答上下文', () => {
  test('只从已持久化且有 Pi entry binding 的 assistant 消息选择 fork 点', () => {
    const messages = [
      { type: 'assistant', uuid: 'completed-1' },
      { type: 'assistant', uuid: 'currently-streaming' },
    ]
    expect(findPreviousCompletedAssistantUuid(messages, { 'completed-1': 'entry-1' })).toBe('completed-1')
  })

  test('没有安全 fork 点时返回 null，由 Agent referenced session 兜底', () => {
    expect(findPreviousCompletedAssistantUuid([{ type: 'assistant', uuid: 'unbound' }], {})).toBeNull()
  })

  test('问答提示词保留选区，不创建 Chat conversation', () => {
    expect(buildAgentSideQuestionPrompt({
      quotedText: '被选中的内容',
      sourceLabel: 'Agent 历史 · Agent 回复',
      question: '请解释这段内容',
      referencedSessionId: 'parent-1',
    })).toContain('被选中的内容')
  })
})
~~~

`apps/electron/src/main/lib/agent-session-manager.test.ts` 增加以下 contract：问答子会话的 `parentSessionId` 等于父 Agent，`archived` 为 true，Pi fork 只复制到指定 `upToMessageUuid`；`apps/electron/src/renderer/components/selection/SelectionActionPopover.test.tsx` 同时覆盖“为 Agent 引用”和“在 Agent 问答中提问”两个动作，并让 mock 的 `createConversation` 抛错，确保测试通过时不会调用 Chat API。

- [ ] **Step 2: 运行失败测试，确认当前实现仍创建 Chat 问答。**

~~~bash
bun test apps/electron/src/renderer/lib/agent-side-question.test.ts apps/electron/src/renderer/components/selection/SelectionActionPopover.test.tsx apps/electron/src/main/lib/agent-session-manager.test.ts
~~~

Expected: 新的上下文 helper、`AgentSidePanelTab = 'qa'` 或问答 IPC 不存在；现有 `onOpenChat/createConversation` 分支使选区测试失败。

- [ ] **Step 3: 定义 Agent 问答子会话的共享输入和主进程服务。**

在 `packages/shared/src/types/agent.ts` 增加明确的 IPC DTO：

~~~ts
export interface CreateAgentSideQuestionSessionInput {
  parentSessionId: string
  upToMessageUuid?: string
  modelId?: string
}

export interface AgentSideQuestionSessionResult {
  session: AgentSessionMeta
  contextMode: 'fork' | 'referenced-session'
  contextMessageUuid?: string
}
~~~

`agent-session-manager.ts` 增加 `createAgentSideQuestionSession(input)`：

1. 校验父 Agent 存在，并使用父会话的 channel、workspace、runtime 和 cwd 作为默认值。
2. `upToMessageUuid`、`piSessionFile` 和 `piEntryBindings` 都有效时，复用 `forkAgentSession` 创建 Pi branch；branch 必须只包含截至该完成 assistant message 的历史。
3. fork 或安全 artifact 不可用时，创建普通 Agent session，返回 `contextMode: 'referenced-session'`，不得伪造 Pi fork 成功。
4. 两种结果都用 `updateAgentSessionMeta` 设置 `title: 'Agent 问答'`、`parentSessionId: parent.id`、`rootSessionId: parent.rootSessionId ?? parent.id`、`archived: true`；归档只用于不污染主会话列表，不能阻止侧面板继续运行该 session。

在 `AGENT_IPC_CHANNELS`、`ipc.ts` 和 `preload/index.ts` 增加 `CREATE_SIDE_QUESTION_SESSION`，返回上述 result。它只负责创建子 Agent，不发送消息；后续消息统一调用现有 `sendAgentMessage`，避免复制 Agent 编排和 Rust SSE 事件链路。

- [ ] **Step 4: 实现“本轮之前”边界和统一打开入口。**

`agent-side-question.ts` 的 `findPreviousCompletedAssistantUuid(messages, piEntryBindings)` 只检查父 Agent 的 `persistedSDKMessages`：过滤 `type === 'assistant'`、有稳定 uuid 且存在 `piEntryBindings[uuid]` 的消息，返回最后一条；绝不能把 `liveMessages` 或当前正在生成的 assistant 增加到 fork 点。

`useOpenAgentQuestion.ts` 负责以下顺序，历史选区和文件预览共用这一入口：

1. 如果父 Agent 正在运行，仍只使用已持久化的上一轮消息；没有安全 fork 点时直接走 `referenced-session`，不能读取未完成 turn。
2. 调用 `window.electronAPI.createAgentSideQuestionSession({ parentSessionId, upToMessageUuid, modelId })`，把返回的子 Agent meta 写入 `agentSessionsAtom`。
3. 将选区写入 `quotedSelectionMapAtom` 的子 session key，而不是父 session 或 Chat conversation key。
4. 将 `agentSideQuestionSessionMapAtom` 写为 `parentSessionId -> childSessionId`，打开侧面板并切换到 `qa`。
5. `contextMode === 'fork'` 时只发送用户问题和选区；`contextMode === 'referenced-session'` 时在 `sendAgentMessage` 中附带 `mentionedSessionIds: [parentSessionId]`，并在提示词中明确要求读取父 Agent 的本轮之前历史。
6. 创建/发送失败时清理本次新增的 renderer map 和 quoted selection，显示中文错误提示，不留下不可用的 qa Tab。

示例提示词格式固定为：

~~~text
请基于本轮之前的 Agent 对话上下文回答问题。

引用来源：{sourceLabel}
---
{quotedText}
---

我的问题：{question}
~~~

- [ ] **Step 5: 保留侧面板问答 Tab，并复用 Agent 视图。**

把 `AgentSidePanelTab` 从 `files | changes | chat` 改为 `files | changes | qa`，增加 `agentSideQuestionSessionMapAtom: atom<Map<string, string>>`。`SidePanel.tsx` 不再导入 `ChatView` 或 `agentSideChatMapAtom`，而是根据父 session 查找子 session 并渲染 `AgentQuestionView`；没有子 session 时显示“暂无 Agent 问答，请从历史或文件中选择内容提问”。关闭 Tab 只切回文件面板并保留子 session 映射，避免用户丢失已进行的问答。

`DiffPanelTabBar.tsx` 保留问答按钮，文案改为“Agent 问答”，使用与文件/改动 Tab 一致的激活态和关闭按钮；它不再接收 `showChatTab/onCloseChat`，而接收 `showQuestionTab/onCloseQuestion`。

`AgentQuestionView.tsx` 使用 `<AgentView sessionId={childSessionId} presentation="side-question" />`。给 `AgentView` 增加 `presentation` 参数：`side-question` 隐藏主窗口 Header、禁止嵌套 SidePanel/Tab 导航和主会话 fork/rewind 操作，保留 AgentMessages、Agent Composer、权限/AskUser/Plan banner、附件和流式状态；所有状态按 child sessionId 读取。`AgentView` 不得通过 `currentQuotedSelectionAtom` 读取父会话引用，必须从 `quotedSelectionMapAtom.get(childSessionId)` 读取。

子 Agent 的流式输出复用 `useGlobalAgentListeners`、`agentStreamingStatesAtom` 和现有 Agent IPC/Rust SSE；不新增 Chat listener、Chat atom 或第二套流式协议。

- [ ] **Step 6: 把历史/预览选区接入 Agent 问答，同时保留直接引用。**

`AgentHistorySelectionLayer.tsx` 和 `DiffTabContent.tsx` 删除 `conversationsAtom`、`conversationDraftsAtom`、`selectedModelAtom`、`agentSideChatMapAtom`、`createConversation` 和本地 Chat handler，改为调用 `useOpenAgentQuestion`。两处都保留 `setQuotedSelectionMap` + `focusAgentSessionInput(sessionId)` 的“为 Agent 引用”动作。

`SelectionActionPopover.tsx` 的 props 固定为：

~~~ts
interface SelectionActionPopoverProps {
  x: number
  y: number
  onAddToAgent: () => void
  onOpenAgentQuestion: () => void | Promise<void>
}
~~~

保留两个按钮，文案分别为“为 Agent 引用”和“在 Agent 问答中提问”；第二个按钮调用 `onOpenAgentQuestion`，不再出现“打开右侧问答”这种 Chat 语义。

`useCloseTab.tsx` 只清理已关闭父 Agent 在 renderer 中的 `agentSideQuestionSessionMapAtom`、quoted selection 和输入焦点状态；不能调用 Chat 删除 API，也不能因为关闭主 Tab 删除已归档 Agent 问答子会话。

- [ ] **Step 7: 运行选区、Agent 问答测试和构建。**

~~~bash
bun test apps/electron/src/renderer/lib/agent-side-question.test.ts apps/electron/src/renderer/components/agent/AgentQuestionView.test.tsx apps/electron/src/renderer/components/selection/SelectionActionPopover.test.tsx apps/electron/src/renderer/components/agent/planning-reference-state.test.ts
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
~~~

Expected: Agent 问答可从已有 session 创建并流式回复；fork 只加载本轮之前的持久化上下文；无安全 fork 点时 `mentionedSessionIds` fallback 可用；SidePanel/DiffTabContent 不再依赖 Chat atoms/API。

- [ ] **Step 8: 提交 Agent 问答 Tab 改造。**

~~~bash
git add packages/shared/src/types/agent.ts apps/electron/src/main/lib/agent-session-manager.ts apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts apps/electron/src/renderer/atoms/agent-atoms.ts apps/electron/src/renderer/atoms/preview-atoms.ts apps/electron/src/renderer/components/agent apps/electron/src/renderer/components/diff apps/electron/src/renderer/components/selection apps/electron/src/renderer/hooks apps/electron/src/renderer/lib/agent-side-question.ts apps/electron/src/renderer/lib/agent-side-question.test.ts
git commit -m "feat: use agent context for side questions"
~~~

## Task 6: 抽出复用组件并删除 Chat UI

**Files:**

- Create: apps/electron/src/renderer/components/model/ModelSelector.tsx、model-selector-utils.ts
- Create: apps/electron/src/renderer/components/attachments/AttachmentPreviewItem.tsx
- Create: apps/electron/src/renderer/components/profile/UserAvatar.tsx
- Create: apps/electron/src/renderer/components/message/CopyButton.tsx、message-format.ts
- Modify: apps/electron/src/renderer/components/agent/AgentView.tsx、SDKMessageRenderer.tsx
- Modify: apps/electron/src/renderer/components/automation/AutomationFormView.tsx、welcome/WelcomeComposer.tsx、settings/GeneralSettings.tsx、settings/VisionRelaySettings.tsx
- Modify: apps/electron/src/renderer/components/ai-elements/scroll-minimap.tsx、session-preview/SessionMiniMapPopover.tsx、tabs/TabPreviewPanel.tsx
- Modify: apps/electron/src/renderer/components/settings/ChannelSettings.tsx、CopisWorkingMessageSettingsPanel.tsx
- Delete: Chat-only files listed in section 2.3

- [ ] **Step 1: 先为复用组件迁移写消费者测试。**

覆盖以下断言：

- AgentView、WelcomeComposer、AutomationFormView 和 VisionRelaySettings 都能从 components/model/ModelSelector.tsx 导入并传入 externalSelectedModel/onModelSelect。
- AgentView 能从 components/attachments/AttachmentPreviewItem.tsx 渲染待发送附件。
- SDKMessageRenderer 能从 components/message/CopyButton.tsx 和 message-format.ts 渲染复制按钮和时间。
- 设置页、SessionMiniMap、TabPreviewPanel 都从 components/profile/UserAvatar.tsx 导入头像。

测试使用现有 React/Bun 测试约定，不引入新的 UI 依赖。

- [ ] **Step 2: 运行测试确认旧路径仍被引用。**

~~~bash
bun test apps/electron/src/renderer/components/agent apps/electron/src/renderer/components/settings apps/electron/src/renderer/components/session-preview
~~~

Expected: 在移动文件前，新的 import 路径不存在或旧组件仍依赖 useConversationSettings，测试/类型检查失败。

- [ ] **Step 3: 移动并解耦模型选择器。**

ModelSelector 只保留通用渠道列表、搜索、模型展示和外部回调；删除 useConversationModelOptional、useConversationIdOptional、conversationsAtom 和 Chat per-conversation 写入。当前 Agent、自动化、欢迎页和视觉助手调用均已提供 externalSelectedModel 与 onModelSelect，选择后的最小行为为：

~~~ts
const handleSelect = (option: ModelOption): void => {
  onModelSelect?.(option)
  setOpen(false)
}
~~~

所有调用方改为从 components/model/ModelSelector 导入。

- [ ] **Step 4: 移动其他 Agent 复用组件。**

复制到新边界后再删除旧文件：

- AttachmentPreviewItem 只接收 FileAttachment、预览 URL、删除回调等 UI props，不引入 Chat atoms。
- CopyButton 只负责复制文本和提示，不引入 Chat 类型。
- formatMessageTime 变成独立纯函数，输入 number 返回格式化字符串。
- UserAvatar 只依赖 userProfile 数据和尺寸/className props。

更新所有消费者 import 后，rg 不应再找到 components/chat/ 的复用组件引用。

- [ ] **Step 5: 删除 Chat UI 和 Chat 专属 hook/context。**

确认 ChatView、ChatInput、Chat message components、Chat context settings、迁移按钮和推荐 Banner 没有剩余 import 后，删除 section 2.3 中的 Chat UI 文件；session-context.tsx 只保留 AgentSessionProvider/useAgentSessionId；删除 useConversationSettings.ts。

SessionMiniMapPopover.tsx 删除 SessionMiniMapType = chat、ChatMessage 预览构建和 getConversationMessages 分支，只保留 Agent SDKMessage 解析。

- [ ] **Step 6: 运行复用组件测试和 Renderer 构建。**

~~~bash
bun test apps/electron/src/renderer/components/agent apps/electron/src/renderer/components/settings apps/electron/src/renderer/components/session-preview
bun run typecheck
bun run --filter='@copis/electron' build:renderer
~~~

Expected: Agent/设置/预览测试 PASS；Renderer 产物不再包含 ChatView 模块。

- [ ] **Step 7: 提交 Chat UI 删除。**

~~~bash
git add apps/electron/src/renderer/components apps/electron/src/renderer/contexts apps/electron/src/renderer/hooks
git commit -m "refactor: remove legacy chat renderer"
~~~

## Task 7: 移除 Chat 主进程、IPC、Preload 和迁移链路

**Files:**

- Modify: apps/electron/src/main/ipc.ts、apps/electron/src/preload/index.ts、apps/electron/src/main/index.ts
- Modify: apps/electron/src/main/lib/agent-session-manager.ts、agent-session-manager.test.ts、tutorial-service.ts、http-api-handler.ts
- Modify: apps/electron/src/renderer/lib/http-api-bridge.ts
- Modify: apps/electron/src/main/lib/migration-service.ts、storage-service.ts、config-paths.ts
- Modify: packages/shared/src/types/agent.ts、packages/shared/src/types/index.ts
- Create: apps/electron/src/preload/index.test.ts、apps/electron/src/main/ipc.test.ts
- Delete: apps/electron/src/main/lib/chat-service.ts、conversation-manager.ts、renderer/hooks/useGlobalChatListeners.ts

- [ ] **Step 1: 写 IPC contract 的失败测试。**

在 apps/electron/src/preload/index.test.ts 和 apps/electron/src/main/ipc.test.ts 新增 source contract test，测试断言：

~~~text
Then window.electronAPI 不包含 listConversations/createConversation/getConversationMessages/sendMessage/stopGeneration/migrateChatToAgent
And IPC 注册列表不包含 chat:list-conversations/chat:send-message/chat:stream:*
And Agent API 仍包含 listAgentSessions/createAgentSession/sendAgentMessage/onAgentStreamEvent
And Agent 文件选择仍可调用 openFileDialog/saveImageAs/saveAttachment
~~~

- [ ] **Step 2: 运行 contract 测试确认旧 API 存在。**

~~~bash
bun test apps/electron/src/preload/index.test.ts apps/electron/src/main/ipc.test.ts
~~~

Expected: 当前 Preload 和 ipc.ts 仍暴露 Chat API，测试 FAIL。

- [ ] **Step 3: 删除 CHAT_IPC_CHANNELS 的 Chat 会话和流式通道。**

从 apps/electron/src/main/ipc.ts 删除以下 handler 组：

- conversation list/create/get/recent/update/delete/pin/archive/search
- send/stop/delete message/truncate/context divider/generate title
- Chat stream chunk/reasoning/complete/error/tool activity listener 注册
- migrateChatToAgentSession handler

从 apps/electron/src/preload/index.ts 同步删除声明、invoke 封装和 listener 封装。AGENT_IPC_CHANNELS 删除 MIGRATE_CHAT_TO_AGENT。主进程退出流程删除 stopAllGenerations() 和 Chat generation 的清理调用。

- [ ] **Step 4: 将 Agent 仍需的文件、附件和教程接口归入通用边界。**

不能因为这些接口历史上使用 CHAT_IPC_CHANNELS 就删除 Agent 能力：

- openFileDialog、文件/文件夹选择结果和 saveAttachment 改用 attachments.ts 的类型，并挂到 FILE_IPC_CHANNELS 或现有通用 IPC_CHANNELS。
- readAttachment、deleteAttachment 只保留被 Agent SDK message/Nano Banana/视觉能力使用的路径，保留路径安全校验。
- saveImageAs、saveResourceFileAs 继续作为桌面原生保存动作。
- getTutorialContent 改成通用 TUTORIAL_IPC_CHANNELS.GET_CONTENT 或 IPC_CHANNELS.GET_TUTORIAL_CONTENT；createWelcomeConversation 完全删除。

教程服务目标只包含：

~~~ts
export function getTutorialContent(): string | null
~~~

http-api-handler.ts 保留静态 Tutorial HTTP route，但不再导入 conversation-manager。

- [ ] **Step 5: 删除 Chat -> Agent 迁移和旧备份/清理分支。**

agent-session-manager.ts 删除 migrateChatToAgentSession() 及 getConversationMessages import；删除 MigrateToAgentButton 和 AgentRecommendBanner 的所有遗留引用。

migration-service.ts 删除 Chat conversation index 的导出、导入、数量统计和 Chat 附件迁移分支；保留 Agent session/workspace、通用工具配置、Skills、MCP 和其他仍有 UI 入口的迁移能力。storage-service.ts 删除 conversations/Chat message orphan cleanup 分类，不要删除 agent-sessions、sdk-config 或工具配置清理。

- [ ] **Step 6: 删除主进程文件并运行主进程/Preload 构建。**

~~~bash
git rm apps/electron/src/main/lib/chat-service.ts apps/electron/src/main/lib/conversation-manager.ts apps/electron/src/renderer/hooks/useGlobalChatListeners.ts
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
~~~

Expected: main/preload 构建成功。

- [ ] **Step 7: 运行 Agent 回归测试。**

~~~bash
bun test apps/electron/src/main/lib/agent-session-manager.test.ts apps/electron/src/main/lib/agent-runtime-env.test.ts apps/electron/src/main/lib/agent-permission-service.test.ts
bun run typecheck
~~~

Expected: Agent session 创建、读取、删除、流式事件和错误处理保持 PASS；没有 Chat 迁移测试或 Chat 类型错误。

- [ ] **Step 8: 提交 IPC 和主进程清理。**

~~~bash
git add apps/electron/src/main apps/electron/src/preload apps/electron/src/renderer/lib packages/shared/src/types
git commit -m "refactor: remove chat main process and ipc"
~~~

## Task 8: 把 Agent 工具配置从 Chat 命名中收敛出来，但保留能力

**Files:**

- Rename: packages/shared/src/types/chat-tool.ts -> agent-tool.ts
- Rename: apps/electron/src/renderer/atoms/chat-tool-atoms.ts -> agent-tool-atoms.ts
- Rename: apps/electron/src/main/lib/chat-tool-config.ts -> agent-tool-config.ts
- Rename: apps/electron/src/main/lib/chat-tool-registry.ts -> agent-tool-registry.ts
- Rename: apps/electron/src/main/lib/chat-tools-watcher.ts -> agent-tools-watcher.ts
- Modify: apps/electron/src/main/lib/builtin-mcp/catalog.ts、web-search-service.ts、adapters/pi-builtin-tools.ts、settings/ToolSettings.tsx、main/index.ts、main/ipc.ts、preload/index.ts
- Create: apps/electron/src/main/lib/builtin-mcp/catalog.test.ts、apps/electron/src/main/lib/agent-tool-config.test.ts
- Preserve storage: ~/.copis/chat-tools.json，除非实现阶段另行增加有测试覆盖的配置迁移
- Delete after call graph audit: apps/electron/src/main/lib/chat-tool-executor.ts、chat-tools/agent-recommend-tool.ts

- [ ] **Step 1: 写 Agent 工具回归测试。**

~~~text
Given Agent 配置已启用 web-search 或 nano-banana
When Pi builtin MCP/catalog 读取工具状态
Then 仍能读取凭据、enabled 状态和可用性

Given 用户在工具设置中切换自定义 HTTP 工具
When 保存并重新加载工具配置
Then Agent 工具列表和配置文件保持一致

Given Agent runtime 建立 Pi 工具
When 运行 web search、vision relay、planning 或 memory
Then 不依赖已删除的 Chat stream/executor
~~~

覆盖 apps/electron/src/main/lib/builtin-mcp/catalog.test.ts 和 apps/electron/src/main/lib/agent-tool-config.test.ts；测试中保留 chat-tools.json 作为历史存储文件名，避免无意丢失用户配置。

- [ ] **Step 2: 运行工具测试确认行为基线。**

~~~bash
bun test apps/electron/src/main/lib/builtin-mcp apps/electron/src/main/lib/agent-tool-config.test.ts
~~~

Expected: 新增的工具配置和内置 MCP 行为测试在重命名前按当前 Chat 命名基线运行，并覆盖配置读写和可用性判断。

- [ ] **Step 3: 只迁移命名和配置 API，不改变 Agent 工具行为。**

共享类型将 ChatToolMeta、ChatToolInfo、ChatToolState、ChatToolsFileConfig 改为 AgentToolMeta、AgentToolInfo、AgentToolState、AgentToolsFileConfig；IPC 常量改为 AGENT_TOOL_IPC_CHANNELS，Renderer API 改为 getAgentTools/updateAgentToolState 等。

配置实现仍从 getChatToolsConfigPath() 读取 ~/.copis/chat-tools.json，因为这是本地配置而不是 Chat 对话数据。将 chat-tool-config.ts 迁移为 agent-tool-config.ts 后，builtin-mcp/catalog.ts、web-search-service.ts 和 ToolSettings.tsx 全部改用新模块。

删除 agent-recommend-tool，因为它的唯一职责是把 Chat 用户推荐到 Agent；删除 chat-tool-executor 前必须确认 rg -n "chat-tool-executor|executeToolCalls" 只剩删除文件本身和测试。联网搜索、Nano Banana 和自定义 HTTP 能力由现有 Agent builtin MCP/服务链保留并通过测试验证。

- [ ] **Step 4: 运行工具测试和主进程构建。**

~~~bash
bun test apps/electron/src/main/lib/builtin-mcp apps/electron/src/main/lib/agent-tool-config.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
~~~

Expected: 工具设置、内置 MCP 可用性和 Agent 构建 PASS；源代码中不再存在 ChatTool 类型和 Chat 工具 IPC 名称，允许的持久化文件名 chat-tools.json 除外。

- [ ] **Step 5: 提交 Agent 工具命名收敛。**

~~~bash
git add packages/shared/src/types apps/electron/src/main/lib apps/electron/src/renderer/atoms apps/electron/src/renderer/components/settings apps/electron/src/preload/index.ts apps/electron/src/main/ipc.ts
git commit -m "refactor: align tool configuration with agent runtime"
~~~

## Task 9: 清理遗留文件、版本和全量验证

**Files:**

- Delete: section 2.3 中所有已确认无引用的 Chat 文件
- Modify: apps/electron/package.json，当前 0.16.19 递增到 0.16.20
- Modify: packages/shared/package.json，当前 0.1.55 递增到 0.1.56
- Modify: bun.lock
- Do not modify: README.md、AGENTS.md

- [ ] **Step 1: 执行删除前静态引用审计。**

~~~bash
rg -n "ChatView|components/chat/|chat-atoms|useGlobalChatListeners|useConversationSettings|createConversation|listConversations|searchConversationMessages|CHAT_IPC_CHANNELS|migrateChatToAgent|type: ['\"]chat['\"]|appMode === ['\"]chat['\"]|setAppMode\\(['\"]chat['\"]\\)" apps/electron/src packages/shared/src
~~~

Expected: 只允许输出本计划中尚未删除的测试/删除清单位置；生产代码不能再有这些符号。chat-tools.json、Agent 工具配置兼容读取和外部 Feishu/WeChat 的“聊天”业务术语不属于 Chat 对话链路，不作为误删依据。

- [ ] **Step 2: 删除无引用文件并确认目录边界。**

使用 rg --files 和 rg -l 再确认一次后删除 Chat-only 文件；如果 components/chat/ 只剩通用移动前的临时文件，则目录一并删除。禁止删除 components/agent/、components/attachments/、components/model/、main/lib/builtin-mcp/、main/lib/web-search-service.ts 或 Agent 数据目录。

- [ ] **Step 3: 更新受影响包 patch 版本。**

只递增受影响包：

~~~text
apps/electron/package.json: 0.16.19 -> 0.16.20
packages/shared/package.json: 0.1.55 -> 0.1.56
~~~

运行 bun install --lockfile-only 或仓库当前等价命令更新 bun.lock，不新增依赖。版本检查命令：

~~~bash
bun pm ls --all | rg '@copis/(electron|shared)'
~~~

Expected: workspace 版本和 package.json 一致。

- [ ] **Step 4: 运行完整验证。**

~~~bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
bun test apps/electron/src/main/lib/legacy-chat-cleanup.test.ts
bun test apps/electron/src/main/lib/agent-session-manager.test.ts
bun test apps/electron/src/renderer/atoms/app-mode.test.ts apps/electron/src/renderer/atoms/tab-atoms.test.ts
bun test
git diff --check
~~~

Expected：类型检查、主进程/Preload/Renderer 构建和 focused tests PASS；全量测试若有既有失败，必须列出失败文件、复现命令和是否与本次 Chat 清理相关，不能用“全量通过”替代证据。

- [ ] **Step 5: 做真实 Electron 窗口 smoke。**

启动开发环境：

~~~bash
bun run dev
~~~

在真实 Electron 窗口验证：

~~~text
Given ~/.copis 下存在旧 conversations.json、conversations/legacy.jsonl 和 attachments/legacy/
When Electron 启动
Then 旧 Chat 数据被删除，agent-sessions/ 和 agent-workspaces/ 保持存在

Given 没有任何 Agent session
When 打开主窗口
Then WelcomeView 创建 Agent draft，输入并发送后显示 Agent 流式消息

Given 有多个 Agent session
When 使用搜索、Ctrl/Cmd+Tab、Ctrl/Cmd+N、系统托盘和历史选区引用
Then 全部操作只打开或创建 Agent；右侧面板保留“Agent 问答”Tab，不创建 Chat conversation

Given 父 Agent 已有至少一轮完成的持久化 assistant 消息
When 在 Agent 历史或文件预览中选中文本并点击“在 Agent 问答中提问”
Then 创建 archived=true、parentSessionId=父 Agent 的 Agent 子会话
And 子会话优先从父 Agent 本轮之前的最后一条完成消息 fork，上下文不包含当前 live turn
And 选中文本作为子 Agent 引用，后续问答通过 Agent IPC/Rust SSE 流式显示在右侧 Tab

Given 父 Agent 没有可用 Pi artifact 或 entry binding
When 打开 Agent 问答
Then 使用 Agent 子会话和 mentionedSessionIds 引用父 Agent 历史，不删除问答入口，也不调用 Chat API

Given 启用联网搜索、Nano Banana 或自定义 Agent 工具
When Agent 发起对应工具调用
Then 工具配置和能力仍可用，未重新创建 conversations/ 目录
~~~

需要同时检查：

- Renderer 控制台没有 ChatView、Chat IPC、createConversation、Tooltip/React 挂载错误。
- 主进程日志没有旧 Chat 目录被重新创建。
- ~/.copis/agent-sessions/、~/.copis/agent-workspaces/ 和 ~/.copis/chat-tools.json 未被清理服务误删。

- [ ] **Step 6: 检查最终 diff 并提交。**

~~~bash
git status --short
git diff --stat
git diff --check
git diff -- README.md AGENTS.md
git add apps/electron/package.json packages/shared/package.json bun.lock apps/electron/src packages/shared/src docs/superpowers/plans/2026-08-05-remove-chat-layer-plan.md
git commit -m "refactor: keep agent conversations only"
~~~

Expected: 最终 diff 不包含 README/AGENTS 改动、密钥、调试输出或无关格式化；工作区只包含本计划涉及的 Agent-only 清理。

## 3. 最终验收清单

- [ ] 旧 Chat 数据清理服务有独立测试，重复执行通过，Agent 数据保持不变。
- [ ] 启动恢复丢弃旧 Chat Tab，没有 Chat fallback。
- [ ] Welcome、搜索、快捷键、快速任务、托盘和 TabSwitcher 只处理 Agent。
- [ ] Agent 右侧面板保留“Agent 问答”Tab；历史/预览选区既可引用当前 Agent，也可打开基于本轮之前上下文的 Agent 问答子会话。
- [ ] Agent 问答子会话的 fork 边界、parentSessionId、archived 标记和无 artifact fallback 都有 focused tests。
- [ ] ChatView、chat-service、conversation-manager、Chat global listener、Chat conversation IPC 和 migrateChatToAgent 全部删除。
- [ ] Agent 仍能创建/恢复/流式运行/停止/删除 session，模型选择和附件引用正常。
- [ ] Agent 的 Planning、Memory、MCP、Skills、文件树、文件预览、联网搜索、Nano Banana 和自定义工具配置没有被清理误伤。
- [ ] README.md 和 AGENTS.md 未被本次计划或实现阶段擅自修改。
- [ ] 版本、类型检查、主进程/Preload/Renderer 构建、focused tests、全量 tests 和真实 Electron smoke 均有记录。

## 4. 实施顺序和提交边界

按 Task 1 到 Task 9 顺序执行。每个 Task 在 focused tests 和对应构建通过后提交一次；出现类型错误时优先完成同一 Task 的 consumer 迁移，不通过删除类型或 any 绕过。任何无法证明只属于旧 Chat 的文件或工具先保留并通过调用图审计，只有在 Agent 回归测试覆盖后才删除。
