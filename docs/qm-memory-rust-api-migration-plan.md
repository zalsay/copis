# QM 风格记忆系统改造计划

## 1. 目标与边界

### 目标

1. 移除 Copis 对 Claude Agent SDK Auto Memory 的依赖，不再把 `.claude/memory/` 作为 Copis 记忆系统。
2. 参考 QM 的 notebook / capture / recall / read / rewrite / revision 思路，建立 Copis 自有记忆模型。
3. 记忆数据由本地 Rust HTTP 服务管理，渲染层通过 `http://127.0.0.1:51730` 访问，不新增记忆相关 Electron IPC。
4. 在左侧导航增加独立的“记忆”入口，不再把记忆作为 Agent 技能页的子 Tab。
5. Agent 使用受控的记忆工具读写当前可见范围，不能通过工具参数选择任意内部 scope。
6. 保留会话 JSONL、`.context` 和已有 Agent 历史，不把会话历史或上下文压缩摘要混入长期记忆。

### 本次不做

- 不在本次改造中删除全部 Claude runtime、历史会话兼容代码或 Claude provider 配置；当前默认 Agent runtime 已是 Pi，先只剥离 Claude 的 Auto Memory 链路。
- 不引入 SQLite、PostgreSQL 或新的外部服务。
- 不修改 `AGENTS.md`、`README.md`，除非后续得到明确允许。
- 不把长期记忆重新实现为可被 Agent 任意读写的文件树。

## 2. 当前代码审计结论

### 现有记忆链路

- `apps/electron/src/main/lib/agent-prompt-builder.ts`
  - 构造 `.claude/memory/`、`MEMORY.md` 路径。
  - 向 Agent 注入 Claude SDK Auto Memory 规则。
- `apps/electron/src/main/lib/agent-session-manager.ts`
  - `ensureClaudeSessionSettings()` 将 `autoMemoryDirectory` 写入 Claude session sidecar。
- `apps/electron/src/main/lib/agent-workspace-manager.ts`
  - 在工作区 `.claude/memory/` 下创建、枚举、读取和写入文件。
  - `getWorkspaceCapabilities()` 将旧 memory 摘要挂到 Skills/MCP 能力摘要。
- `apps/electron/src/renderer/components/agent-skills/WorkspaceMemoryTab.tsx`
  - 现有记忆文件树和编辑器直接调用 `window.electronAPI`。
- `apps/electron/src/main/ipc.ts` 与 `apps/electron/src/preload/index.ts`
  - 注册旧 memory summary、文件树、读取和写入 IPC。

### 现有 Rust HTTP 链路

- `native/http-api-server/src/main.rs` 监听 `127.0.0.1:51730`。
- 普通 `/api/*` 请求当前通过 stdin/stdout 协议转给 Electron 业务桥；Pi Agent SSE 已由 Rust 特殊处理。
- `apps/electron/vite.config.ts` 将 `/api` 代理到 Rust 服务。
- `apps/electron/src/renderer/lib/http-api-bridge.ts` 已证明渲染层可以使用 Rust HTTP 替代 Electron API。
- `apps/electron/src/main/lib/http-api-server.ts` 启动 Rust 服务时可以注入 `COPIS_MEMORY_DIR`，使 Rust 使用与 Electron 一致的 `~/.copis` 或 `~/.copis-dev`。

## 3. 目标架构

```text
左侧 Memory 菜单
        |
        v
MemoryView + Jotai atoms
        |
        v
renderer/lib/memory-api.ts
        |
        v
Rust HTTP API :51730
        |
        v
Rust MemoryStore
  entries.json
  revisions.jsonl
        |
        +--> Pi memory tools（通过 HTTP API 调用）
        +--> Agent prompt 中的 Copis Memory 使用规则
```

### 存储位置

Electron 启动 Rust 服务时传入：

```text
COPIS_MEMORY_DIR=<Copis 配置目录>/memory
```

典型路径：

```text
~/.copis-dev/memory/
├── entries.json       # 当前有效记忆快照，原子替换写入
└── revisions.jsonl    # 每次 capture/rewrite/restore 的历史快照
```

`entries.json` 负责快速启动和列表读取；`revisions.jsonl` 负责审计、历史查看和恢复。写入时使用进程内 Mutex、临时文件和 rename，避免并发请求产生半写文件。

## 4. 记忆数据模型

新增 `packages/shared/src/types/memory.ts`，并从 `packages/shared/src/types/index.ts` 导出。

```text
MemoryScope = user | workspace
MemoryKind = fact | preference | decision | project | scratch
MemorySource = agent | user | import
```

核心字段：

- `id: string`
- `scope: MemoryScope`（只返回受控 scope，不暴露任意内部 scope 名）
- `workspaceSlug?: string`（workspace scope 必须有值；user scope 不带值）
- `kind: MemoryKind`
- `title: string`
- `content: string`
- `tags: string[]`
- `source: MemorySource`
- `createdAt: number`
- `updatedAt: number`
- `revision: number`
- `archived: boolean`

Revision 记录保存完整旧快照：

- `memoryId`
- `revision`
- `operation: capture | rewrite | restore | archive`
- `snapshot: MemoryEntry`
- `createdAt`

规则：

- 同一 scope 中，经过规范化后的相同内容不重复创建，返回已有条目并标识 deduplicated。
- 列表默认隐藏 archived 条目；搜索支持 `includeArchived=false` 的默认行为。
- 搜索结果限制在服务端，默认 20、最大 50； Agent recall 默认 8、最大 8。
- rewrite 使用 `expectedRevision`，版本不一致返回 409 和当前记录，避免 UI 或 Agent 覆盖新内容。
- restore 不是回写旧 revision 号，而是创建一个新的 revision，保留完整恢复轨迹。
- 当前 workspace 的 Agent 可以看到 `user` 记忆和当前 workspace 记忆；不同 workspace 之间严格隔离。

## 5. Rust HTTP API

在 `native/http-api-server/src/memory.rs` 实现 `MemoryStore` 和纯业务测试，在 `main.rs` 增加本地 memory 路由。Memory 路由必须在 Electron bridge 转发之前处理。

### UI / 管理 API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/memory?workspaceSlug=...&q=...&scope=...&limit=...` | 列出或搜索当前可见记忆 |
| GET | `/api/memory/stats?workspaceSlug=...` | 返回 user/workspace/archived 计数 |
| GET | `/api/memory/:id?workspaceSlug=...` | 读取单条记忆 |
| POST | `/api/memory` | capture；body 含 `workspaceSlug`、`scope`、`kind`、`title`、`content`、`tags`、`source` |
| PATCH | `/api/memory/:id` | rewrite；body 含 `workspaceSlug`、可变字段和 `expectedRevision` |
| DELETE | `/api/memory/:id?workspaceSlug=...` | 归档条目并记录 revision |
| GET | `/api/memory/:id/history?workspaceSlug=...` | 读取 revision 历史 |
| POST | `/api/memory/:id/restore` | body 含 `workspaceSlug`、`revision`，从历史生成新 revision |

### Agent API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/api/memory/recall` | body 只接收当前 workspace 上下文、query 和 limit，由服务合并 user/workspace 可见范围 |
| POST | `/api/memory/capture` | body 只接收记忆内容和 kind，scope 由 Agent 工具固定为当前 workspace |
| GET | `/api/memory/:id/read?workspaceSlug=...` | Agent 读取已检索到的条目 |
| PATCH | `/api/memory/:id/rewrite` | Agent 按 revision 乐观更新，不能提交任意 scope |

实现时可以让管理 API 与 Agent API 复用同一 `MemoryStore` 方法，但要分开输入校验，避免 Agent 传入内部路径或任意 workspace scope。

错误约定：

- 400：workspace、kind、内容、revision 等参数不正确。
- 404：条目不存在或不属于当前 workspace 可见范围。
- 409：`expectedRevision` 冲突。
- 413：沿用当前 HTTP body 上限。
- 500：存储读写失败。

## 6. Agent 接入

### Pi 工具

在 `apps/electron/src/main/lib/adapters/pi-builtin-tools.ts` 增加一组默认启用的 Copis memory tools。工具内部通过本地 Rust HTTP API 调用，不通过 Electron IPC。

建议工具：

- `memory_recall(query, limit?)`
  - 搜索 user memory + 当前 workspace memory。
  - 返回短摘要、id、kind、scope、updatedAt；必要时再调用 read。
- `memory_read(id)`
  - 只能读取当前会话 workspace 可见的 id。
- `memory_capture(title, content, kind, tags?)`
  - scope 固定为当前 workspace；对明显的长期用户偏好由 Agent 在提示规则中先建议确认。
- `memory_rewrite(id, content/title/tags, expectedRevision)`
  - 必须携带检索到的 revision，冲突时返回当前内容供 Agent 重新判断。

工具上下文从 `PiBuiltinToolsContext.workspaceSlug` 获取 workspace，工具 schema 不暴露原始 scope id、文件路径或任意 workspace slug。没有 workspace 时只允许 recall user memory，不允许写入 workspace memory。

### Prompt 调整

在 `agent-prompt-builder.ts`：

- 删除 `.claude/memory/`、`MEMORY.md`、`autoMemoryDirectory` 相关说明。
- 将“SDK auto memory”章节替换为“Copis Memory”章节。
- 明确区分：
  - Memory：跨会话的稳定事实、偏好、决策和项目经验。
  - `.context`：当前会话工作台和项目级长文档。
  - session JSONL：聊天历史和上下文压缩摘要。
  - Skills：可复用流程，不是事实仓库。
- 指示 Agent 先 recall，再按需 read；只有稳定、可复用且有足够证据的信息才 capture；冲突时 rewrite，不追加相反条目。
- 不给 Agent 注入本地 memory 文件路径，避免回退到文件编辑模式。

在 `agent-session-manager.ts`：

- 停止向 Claude sidecar 写入 `autoMemoryDirectory`。
- 保留历史 Claude session settings 的其他兼容字段，避免本次改造影响无关历史会话。

## 7. 独立左侧 Memory UI

### 导航与视图

- `apps/electron/src/renderer/atoms/active-view.ts`
  - `ActiveView` 增加 `'memory'`。
- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
  - 增加独立 `MemorySidebarEntry`，与 Planning、Agent 技能同级。
  - 不依赖当前 Chat/Agent 模式；点击后只切换 `activeViewAtom`。
- `apps/electron/src/renderer/components/tabs/MainArea.tsx`
  - `activeView === 'memory'` 时渲染新的 `MemoryView`，隐藏 TabBar 和会话内容。
- `AgentSkillsView.tsx`
  - 移除 Memory 子 Tab、计数和 `WorkspaceMemoryTab` 引用；Agent 技能页只负责 Skills/MCP。

### Jotai 状态

新增 `apps/electron/src/renderer/atoms/memory-atoms.ts`，至少包含：

- 当前 workspace slug / scope filter
- 搜索关键词
- 记忆列表和统计
- 当前选中条目
- 当前 revision 历史
- editor draft、editor mode、dirty/loading/saving 状态
- refresh token

新增 `apps/electron/src/renderer/components/memory/MemoryView.tsx`，拆分为：

- `MemoryToolbar`：搜索、scope/kind 筛选、新建、刷新。
- `MemoryList`：按 scope/kind 展示，显示标题、摘要、更新时间、revision。
- `MemoryEditor`：预览/编辑、保存、归档。
- `MemoryHistory`：revision 列表和恢复操作。

所有网络操作通过 `renderer/lib/memory-api.ts` 的 fetch 访问 `/api/memory/*`。不调用 `window.electronAPI.getWorkspaceMemorySummary`、文件树、读取或写入方法。

### 交互要求

- 无 workspace 时仍可以浏览 user memory；新建 workspace memory 时给出明确提示。
- 列表搜索和服务端 recall 使用同一套关键词语义。
- 编辑保存失败且返回 409 时保留本地草稿，展示当前 revision，允许用户重新合并。
- 恢复 revision 前要求确认，并在完成后刷新当前记录和历史。
- UI 只展示记忆条目，不展示内部存储绝对路径。

## 8. 旧链路清理与迁移

实现新 API 和 UI 完成后，再删除旧的 memory IPC 表面，避免中间状态出现双写：

1. 删除 `WorkspaceMemorySummary`、旧 memory 文件树类型及对应 IPC channel。
2. 删除 preload 中旧 memory methods 和 `ipc.ts` handler。
3. 删除 `agent-workspace-manager.ts` 的 `.claude/memory` 文件操作、能力摘要 memory 字段和相关 import。
4. 删除 `WorkspaceMemoryTab.tsx`，或确认无引用后移出 Agent Skills 目录。
5. 搜索并更新 `default-skills/copis-coach/SKILL.md`、prompt 模板中对 `.claude/memory` 的说明；若修改 Skill，按项目约定递增该 Skill frontmatter 的 patch version。
6. 对已有 `.claude/memory` 文件采取只读保留策略，不在启动时继续写入；第一版不做静默删除。后续如需迁移，可增加显式“导入旧记忆”动作，避免把不完整文件自动当成结构化事实。

## 9. BDD 测试计划

### Rust MemoryStore

在 `native/http-api-server/src/memory.rs` 添加临时目录测试：

- Given 空 notebook，When capture 一条 workspace memory，Then entries.json 可加载且 revision 从 1 开始。
- Given 同 scope 相同规范化内容，When capture 两次，Then 只有一条 active entry，第二次返回 deduplicated。
- Given workspace A 和 workspace B，When recall，Then 两边不能看到对方 workspace memory，但都能看到 user memory。
- Given query、limit 超限或空 query，When recall/search，Then 服务端限制结果数且拒绝非法参数。
- Given revision=1 的条目，When rewrite expectedRevision=0，Then 返回 conflict 且原记录不被覆盖。
- Given revision history，When restore revision=1，Then 当前 revision 增加，旧 revision 仍保留。
- Given archived 条目，When 默认 list，Then 不返回；When includeArchived=true，Then可审计读取。
- Given 进程重启模拟，When 重新打开同一临时目录，Then entries 和 revisions 都可恢复。

### HTTP 路由

- 健康检查和现有 bridge 路由不回归。
- Memory 路由不进入 Electron bridge。
- 非法 workspace、非法 scope、跨 workspace id 访问都返回统一 400/404。
- CORS、OPTIONS、204 与现有 HTTP 服务行为一致。

### TypeScript / UI

- memory API client 对 409 保留错误 code 和当前 revision payload。
- `activeViewAtom` 切换到 memory 时主区显示 MemoryView，Agent Skills 不再显示记忆 Tab。
- 保存、归档、恢复后 Jotai 列表和历史状态刷新。
- UI 不出现任何旧 memory Electron IPC 调用（用 `rg` 做静态检查）。

## 10. 实施顺序

1. 先实现共享 Memory 类型和 Rust `MemoryStore`，完成纯 Rust BDD 测试。
2. 在 Rust server 中接入 `/api/memory/*` 路由，并注入 `COPIS_MEMORY_DIR`。
3. 增加 renderer memory API client、Jotai atoms 和独立 MemoryView。
4. 增加左侧导航和 MainArea 视图分支，移除 Agent Skills 的 memory Tab。
5. 增加 Pi Agent memory tools，替换 system prompt 与 Claude Auto Memory 配置。
6. 清理旧 memory IPC、preload、workspace 文件服务和类型。
7. 更新受影响 package patch version；只在用户允许后同步 README/AGENTS 文档。
8. 执行完整验证并检查 staged diff，确认没有误删历史 Claude runtime 代码。

## 11. 完成验证

```bash
cargo test --manifest-path native/http-api-server/Cargo.toml
bun test packages/shared/src/utils/capabilities-diff.test.ts
bun run --filter='@copis/shared' typecheck
bun run --filter='@copis/electron' typecheck
bun run --filter='@copis/electron' build:http-api-server
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
git diff --check
```

完成构建后启动实际 Electron 窗口，验证：

- 左侧“记忆”入口可见且独立于 Agent 技能。
- capture、搜索、编辑、revision、restore、归档均通过 `127.0.0.1:51730` 成功。
- Agent 能 recall 当前 workspace 记忆，但不能访问其他 workspace。
- 开发者工具中没有旧 memory IPC 调用，也没有 `.claude/memory` 自动写入。
