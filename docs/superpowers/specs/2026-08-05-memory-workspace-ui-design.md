# Copis Memory 工作台 UI 重构设计

## 1. 背景

当前 Memory 页面把项目记忆、策略选择、搜索筛选和编辑操作集中在同一条工具栏与左右分栏中。它可以完成基础管理，但没有清楚表达以下边界：

- 记忆属于当前项目、其他项目还是用户全局。
- 当前项目策略与全局默认策略的关系。
- 记忆管理和记忆导出的关系。
- 页面展示名称与内部 workspace slug 的区别。

本设计将独立 Memory 页面重构为一个带作用域导航的 Memory 工作台，沿用已实现的 `off / visible / writable` 策略、SQLite 存储、workspace 隔离、revision 和 scratch 维护逻辑。

## 2. 目标与范围

### 2.1 目标

1. 用户能够在一个独立页面中清楚管理当前项目、全部项目、全局策略和导出。
2. 页面顶部始终显示真实项目名称，并通过下拉框切换项目；不把 `default` 或 slug 作为固定展示名称。
3. 全局默认策略与项目覆盖策略在 UI 和数据流上明确分开。
4. 支持 JSON 与 Markdown 两种导出格式，导出不修改数据库。
5. 保留现有 Memory API、策略矩阵、revision 冲突保护和 user/workspace 可见性。

### 2.2 范围内

- Renderer Memory 页面布局与组件拆分。
- 项目切换、全部项目概览、全局设置、导出页面。
- Memory 导出查询与 typed API client。
- 页面空状态、加载状态、错误状态、无项目状态和权限提示。
- Memory 页面 focused BDD 测试、导出 API 测试和必要的 typecheck/build 验证。

### 2.3 范围外

- 功能模块安装、激活、manifest、发布或远程下载链路。
- Nowledge Mem、Claude Auto Memory、Markdown notebook 运行时链路。
- Memory SQLite schema 的重新设计；导出直接读取现有 entries/revisions 数据。
- Chat、Agent 会话、Planning 和 MCP 的非 Memory UI 重构。
- 修改 `AGENTS.md` 或 `README.md`。

## 3. 信息架构

独立 Memory 页面使用左侧固定导航，主内容区根据导航项切换：

```text
记忆
├── 当前项目
├── 全部项目
├── 全局设置
└── 导出记忆
```

### 3.1 当前项目

页面顶部显示：

- `当前项目` 标签。
- 项目下拉选择器，选项显示 `AgentWorkspace.name`，可辅以本地/远程等已有状态；内部值使用 workspace id 或 slug。
- 当前项目 Memory policy 状态。
- 当前项目的记忆数量、scratch 数量、最近维护进度。

内容区保留现有搜索、类型筛选、归档筛选、列表、编辑器和 revision history 能力。列表只请求 user memory 与当前 workspace memory，不把其他 workspace 内容混入。

项目策略下拉框修改当前 workspace 的 `memoryPolicy`。没有可用项目时，页面进入用户记忆模式，不能创建 workspace memory，也不能触发 Agent 自动写入。

### 3.2 全部项目

全部项目页是项目概览，不是跨项目混合记忆列表。每个项目行或卡片展示：

- 项目展示名称。
- 项目 slug 或本地路径的非敏感摘要；不展示绝对路径作为主信息。
- user + workspace 记忆数量。
- 当前项目策略：继承全局、关闭、只读或可写。
- 最近维护状态。

点击项目后切换到「当前项目」并选中该项目。user memory 的统一入口保留在当前项目页和导出页，不复制成多个编辑源。

### 3.3 全局设置

全局设置页只负责全局默认行为：

- 默认 Memory policy：可写、只读、关闭。
- 说明：仅对没有项目覆盖策略的 workspace 生效。
- 无 workspace 时的行为说明：context/recall 只能看 user memory，Agent 不自动写入。
- 自动捕获与维护规则的只读说明：静默 180 秒、累计 10 轮、scratch 14 天、最近 2 天 context、累计 10 条维护。

固定规则在第一版只展示，不增加新的配置字段，避免 UI 暴露尚未实现的可变参数。

### 3.4 导出记忆

导出页使用明确的步骤式表单，但不引入多页面向导：

1. 选择导出范围：当前项目、全部项目、用户记忆。
2. 选择格式：JSON、Markdown。
3. 选择内容：是否包含归档条目、是否包含 revision history。
4. 预览数量与范围摘要。
5. 点击对应格式的导出按钮，触发本地文件下载。

导出始终是只读操作，不改变 active/archived 状态、revision 或 maintenance marker。

## 4. 策略与作用域

### 4.1 策略解析

```text
workspace.memoryPolicy
    ↓ 未设置
settings.defaultMemoryPolicy
    ↓ 未设置
writable
```

Renderer 显示解析后的 effective policy，同时在全局设置和项目设置中标明该值来自覆盖还是继承。

### 4.2 展示名称与内部标识

- UI 文案使用 `AgentWorkspace.name`。
- API 请求使用稳定的 workspace slug/id。
- 任何 UI 文本不得把 `default`、slug 或绝对路径当作项目名称。
- 项目切换后清空旧项目选中条目、draft、history、maintenance 状态，再加载新作用域。

### 4.3 policy 行为保持不变

| Policy | 自动 context | Memory read tools | Memory write tools | 页面管理 |
| --- | --- | --- | --- | --- |
| `off` | 禁止 | 不注册 | 禁止 | 允许用户查看/编辑 |
| `visible` | 允许 | 允许当前可见 scope | 禁止 | 允许用户查看/编辑 |
| `writable` | 允许 | 允许当前可见 scope | 允许当前 workspace | 允许用户查看/编辑 |

页面上的策略切换只更新配置；Memory 条目仍通过既有 Rust HTTP API 写入，Renderer 不直接打开 SQLite。

## 5. 导出契约

### 5.1 API 形状

新增主进程 typed client 方法，底层访问 Rust Memory HTTP 服务：

```ts
export type MemoryExportScope = 'current-workspace' | 'all-workspaces' | 'user'
export type MemoryExportFormat = 'json' | 'markdown'

export interface MemoryExportInput {
  scope: MemoryExportScope
  workspaceSlug?: string
  format: MemoryExportFormat
  includeArchived: boolean
  includeHistory: boolean
}

export interface MemoryExportResponse {
  fileName: string
  mimeType: string
  content: string
  entryCount: number
  revisionCount: number
}
```

导出由 Rust 服务完成查询和序列化，Electron 主进程负责把返回内容交给本地保存对话框或下载管道。Renderer 只传 typed input，不拼接 SQL 或文件路径。

### 5.2 JSON 格式

JSON 用于备份、迁移和程序恢复，包含：

- `schemaVersion`。
- `exportedAt`。
- `scope` 与可选 `workspace` 元信息。
- `entries`：完整 MemoryEntry 字段，包括 scope、kind、source、capturedAt、archived、expiresAt、revision。
- `revisions`：当 `includeHistory=true` 时提供完整 revision snapshot；否则为空数组。

JSON 导出不包含 API key、系统 endpoint、headers、绝对本地路径或无权限 workspace 内容。

### 5.3 Markdown 格式

Markdown 用于阅读和分享，结构为：

```markdown
# Copis Memory Export

## 用户记忆
...

## 项目：copis
### 偏好
...
### 决策
...
### 事实
...
```

归档条目单独放在 `## 已归档`；revision history 以条目下的折叠式或时间顺序小节呈现，不改变当前条目正文。

## 6. 组件边界

建议组件拆分：

```text
MemoryView
├── MemoryWorkspaceNav
├── MemoryProjectSelector
├── MemoryProjectOverview
├── MemoryEntryBrowser
├── MemoryGlobalSettings
├── MemoryExportView
├── MemoryExportForm
└── MemoryEditor / MemoryHistory
```

- `MemoryView`：管理当前子页面、workspace 选择和公共数据加载。
- `MemoryWorkspaceNav`：只负责导航，不直接访问 API。
- `MemoryProjectSelector`：展示项目 name，向上派发 workspace 切换。
- `MemoryProjectOverview`：当前项目的统计、policy 和条目浏览。
- `MemoryGlobalSettings`：读取/更新 `defaultMemoryPolicy`。
- `MemoryExportView` / `MemoryExportForm`：收集范围与格式并触发本地导出。
- `MemoryEditor` / `MemoryHistory`：沿用现有 revision 冲突、restore 和 archive 行为。

状态继续使用 Jotai，不增加 localStorage 或新的数据库。导出表单状态只保存在当前页面 atoms 或局部 React state 中。

## 7. 状态与错误处理

- 项目加载中：项目选择器显示 loading，内容区不展示旧项目条目。
- 无项目：显示“仅用户记忆”状态；项目 selector 显示无项目，不伪造 `default`。
- 当前项目为空：保留新建入口和清晰 empty state。
- 导出为空：显示 scope、entryCount=0，并允许导出空结构文件；不生成错误文件。
- 导出失败：显示可操作的中文错误，不改变页面筛选和草稿。
- policy 更新失败：恢复原选择值并提示失败原因。
- 409 revision 冲突：沿用现有本地 draft 保留行为。
- 服务不可用：全局设置可从配置读取；Memory 数据页显示服务不可用，不让普通页面崩溃。

## 8. 视觉与交互原则

- 采用现有 Copis 深色工作区 UI，不新增独立主题。
- 左侧导航提供稳定的作用域心智模型，内容区顶部固定项目选择。
- 当前项目名称使用标题级别展示，slug 作为次要辅助信息或隐藏内部值。
- policy 使用带文字的 select/segmented control，不使用难以理解的图标替代。
- 导出范围和格式使用清晰的分段控件或单选组，避免把 JSON/Markdown 藏在菜单深处。
- 保持现有 8px 以内圆角、紧凑工作台密度和可扫描列表。
- 不使用营销式 hero、装饰性渐变、无意义的卡片嵌套或虚构数据。

## 9. BDD 验收场景

```text
Given 当前项目名称为“copis”
When 打开 Memory / 当前项目
Then 页面顶部显示“copis”而不是“default”或 slug
And 项目下拉框可切换到另一个项目
And 切换后只显示 user + 新项目 memory

Given workspace 没有自定义 policy
When 打开 Memory / 全局设置
Then 显示 defaultMemoryPolicy
And 页面标记该策略会被项目继承

Given workspace 已设置 memoryPolicy=visible
When 打开 Memory / 当前项目
Then 显示“项目策略：只读”
And 全局默认策略变化不会覆盖该项目策略

Given 存在 user、项目 A、项目 B 记忆
When 在 Memory / 导出中选择“项目 A + JSON”
Then 只导出 user 与项目 A 的授权内容
And 不包含项目 B
And 数据库内容与 revision 不发生变化

Given 选择 Markdown 和包含历史
When 点击导出
Then 下载 Markdown 文件，按用户/项目/类型组织
And revision history 以独立历史区块呈现

Given 导出服务失败
When 提交导出
Then 页面显示中文错误
And 当前项目选择、筛选条件和草稿保持不变
```

## 10. 验证范围

- Memory 页面 focused component tests。
- project selector、global policy 和 export form 的 BDD tests。
- shared typecheck、Electron typecheck、main/renderer build。
- Rust Memory export route tests、SQLite integrity 和 workspace isolation smoke。
- 实际 Electron 窗口中验证项目切换、策略继承/覆盖、JSON/Markdown 下载和无跨项目泄漏。

## 11. 未决实现顺序

实现时按以下顺序推进：

1. 先拆分 Memory 页面导航与当前项目 selector，修正 name/slug 展示边界。
2. 增加全部项目与全局设置页面，复用现有 workspace/settings IPC。
3. 增加导出 shared types、Rust route、主进程 client 和本地下载链路。
4. 增加导出页面与 JSON/Markdown BDD 测试。
5. 做完整构建和实际 Electron smoke，最后再决定是否需要补充视觉细节。
