# Memory 工作台与导出实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将独立 Memory 页面重构为按当前项目、全部项目、全局设置和导出分层的本地工作台，并让 JSON/Markdown 导出安全地读取现有 SQLite 数据。

**Architecture:** Renderer 继续使用 Jotai 和现有 Memory HTTP client；Rust MemoryStore 增加只读 export 查询和序列化；Electron 主进程只负责原生 Save As 对话框，不直接操作 SQLite。项目展示使用 `AgentWorkspace.name`，API 和导出内部标识使用 slug；workspace policy 使用 `null` 表示清除覆盖并回退到全局默认值。

**Tech Stack:** React 18、Jotai、Tailwind、Lucide、Electron IPC、Rust `rusqlite`/`serde_json`、Bun test、Cargo test。

---

### Task 1: 对齐共享类型与项目策略覆盖语义

**Files:**
- Modify: `packages/shared/src/types/memory.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/electron/src/main/lib/agent-workspace-manager.ts:402-438`
- Modify: `apps/electron/src/main/ipc.ts:2531-2538`
- Modify: `apps/electron/src/preload/index.ts:719,1962`
- Test: `apps/electron/src/main/lib/agent-workspace-manager.test.ts`

- [ ] **Step 1: Write the failing BDD tests**

增加两个行为断言：workspace policy 可用 `null` 清除覆盖；清除后 workspace 对象不再含 `memoryPolicy`，从而可以继承全局策略。

```ts
test('清除 workspace memoryPolicy 后回退为未设置', () => {
  const workspace = createAgentWorkspace('Memory UI 项目')
  const updated = updateAgentWorkspace(workspace.id, { memoryPolicy: 'visible' })
  expect(updated.memoryPolicy).toBe('visible')
  const inherited = updateAgentWorkspace(workspace.id, { memoryPolicy: null })
  expect(inherited.memoryPolicy).toBeUndefined()
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts`

Expected: FAIL because the update input does not accept `null` and the existing object spread retains the old override.

- [ ] **Step 3: Implement the minimal contract change**

将 workspace update 的 `memoryPolicy` 输入改为 `MemoryPolicy | null`，在 manager 中重建对象时先移除旧字段，再仅在值为实际策略时写回；同步 IPC 和 preload 的参数类型。新增 `MemoryExportScope`、`MemoryExportFormat`、`MemoryExportInput` 和 `MemoryExportResponse` 到 shared memory types，供后续 Rust/client/UI 共用。

- [ ] **Step 4: Run the focused test and typecheck**

Run: `bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts`

Expected: PASS。

Run: `bun run typecheck`

Expected: PASS。

### Task 2: 增加 SQLite Memory 导出查询与序列化

**Files:**
- Modify: `native/http-api-server/src/memory.rs`
- Modify: `native/http-api-server/src/main.rs:20-30,306-533`
- Test: `native/http-api-server/src/memory.rs`

- [ ] **Step 1: Write failing Rust export tests**

覆盖当前项目隔离、全部项目不泄漏、归档开关、revision history 和 Markdown 分组：

```rust
#[test]
fn export_current_workspace_includes_user_and_selected_project_only() {
    let directory = TestDirectory::new();
    let store = MemoryStore::open(&directory.0).unwrap();
    let user = store.capture(user_capture("用户内容")).unwrap();
    let project_a = store.capture(workspace_capture("project-a", "A 内容")).unwrap();
    let project_b = store.capture(workspace_capture("project-b", "B 内容")).unwrap();
    let result = store.export(MemoryExportInput {
        scope: MemoryExportScope::CurrentWorkspace,
        workspace_slug: Some("project-a".to_string()),
        format: MemoryExportFormat::Json,
        include_archived: false,
        include_history: true,
    }).unwrap();
    let json: serde_json::Value = serde_json::from_str(&result.content).unwrap();
    let ids: Vec<&str> = json["entries"].as_array().unwrap()
        .iter().map(|entry| entry["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&user.entry.id.as_str()));
    assert!(ids.contains(&project_a.entry.id.as_str()));
    assert!(!ids.contains(&project_b.entry.id.as_str()));
    assert_eq!(result.revision_count, 2);
}

#[test]
fn export_all_workspaces_markdown_groups_projects_and_archived_entries() {
    let directory = TestDirectory::new();
    let store = MemoryStore::open(&directory.0).unwrap();
    store.capture(user_capture("用户内容")).unwrap();
    store.capture(workspace_capture("project-a", "A 内容")).unwrap();
    let archived = store.capture(workspace_capture("project-b", "B 内容")).unwrap();
    store.archive(&archived.entry.id, Some("project-b")).unwrap();
    let result = store.export(MemoryExportInput {
        scope: MemoryExportScope::AllWorkspaces,
        workspace_slug: None,
        format: MemoryExportFormat::Markdown,
        include_archived: true,
        include_history: false,
    }).unwrap();
    assert!(result.content.contains("## 用户记忆"));
    assert!(result.content.contains("## 项目：project-a"));
    assert!(result.content.contains("## 项目：project-b"));
    assert!(result.content.contains("## 已归档"));
}
```

- [ ] **Step 2: Run the Rust tests and verify they fail**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml memory::tests::export_`

Expected: FAIL because export input, store method and response do not exist.

- [ ] **Step 3: Implement export contracts and store query**

在 `memory.rs` 增加 camelCase wire structs/enums：`MemoryExportScope`、`MemoryExportFormat`、`MemoryExportInput`、`MemoryExportResponse`。实现 `MemoryStore::export`：

- `user` 只取 user scope；
- `current-workspace` 需要合法 `workspaceSlug`，取 user + 目标 workspace；
- `all-workspaces` 取所有 workspace 与 user；
- `includeArchived=false` 排除归档，`true` 保留归档；
- `includeHistory=true` 只返回导出条目对应的 revision；
- JSON 使用 `schemaVersion/exportedAt/scope/entries/revisions`；
- Markdown 按用户、项目 slug、Memory kind 组织，归档条目放到独立区块；
- 文件名只使用固定前缀和已校验 scope/slug，返回 `application/json` 或 `text/markdown`。

在 `main.rs` 的 `/api/memory/export` POST 路由解析输入并调用 `store.export`，保持现有 Memory 错误映射和 CORS 行为。

- [ ] **Step 4: Run the Rust tests and build**

Run: `cargo test --manifest-path native/http-api-server/Cargo.toml`

Expected: PASS。

Run: `cargo build --manifest-path native/http-api-server/Cargo.toml`

Expected: PASS。

### Task 3: 接通 Renderer client、Electron Save As 和 typed preload API

**Files:**
- Modify: `apps/electron/src/renderer/lib/memory-api.ts`
- Modify: `apps/electron/src/main/lib/memory-api-client.ts`
- Modify: `apps/electron/src/main/ipc.ts`
- Modify: `apps/electron/src/preload/index.ts`
- Test: `apps/electron/src/main/lib/memory-api-client.test.ts`

- [ ] **Step 1: Write failing client and save contract tests**

增加 client export 请求断言，确认 query/body 保留 scope、format、归档和 history；增加保存 handler 的输入校验测试（复用 IPC 现有测试风格）。

```ts
test('export sends the typed scope and serialization options', async () => {
  const response = await memoryApiClient.export({
    scope: 'current-workspace',
    workspaceSlug: 'project-a',
    format: 'markdown',
    includeArchived: true,
    includeHistory: false,
  })
  expect(response.mimeType).toBe('text/markdown')
})
```

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `bun test apps/electron/src/main/lib/memory-api-client.test.ts`

Expected: FAIL because the typed `export` method is absent.

- [ ] **Step 3: Implement the clients and local save bridge**

在 Renderer 和 main Memory client 中增加 `export(input)`，POST `/api/memory/export`。在 `ElectronAPI` 增加：

```ts
saveMemoryExport: (input: { fileName: string; content: string; mimeType: string }) => Promise<boolean>
```

preload 通过 `ipcRenderer.invoke('memory:save-export', input)` 桥接。主进程 handler 使用当前窗口的 `dialog.showSaveDialog`，根据 mime type 设置 `.json`/`.md` 过滤器，取消返回 `false`，成功以 UTF-8 写入用户选择的路径。输入只接受有限文件名、字符串内容和两种 MIME，避免把任意 IPC payload 当作文件路径执行。

- [ ] **Step 4: Run focused tests and typecheck**

Run: `bun test apps/electron/src/main/lib/memory-api-client.test.ts`

Expected: PASS。

Run: `bun run typecheck`

Expected: PASS。

### Task 4: 用 Jotai 重构 Memory 工作台和项目 selector

**Files:**
- Modify: `apps/electron/src/renderer/atoms/memory-atoms.ts`
- Modify: `apps/electron/src/renderer/components/memory/MemoryView.tsx`
- Modify: `apps/electron/src/renderer/components/memory/MemoryToolbar.tsx`
- Create: `apps/electron/src/renderer/components/memory/MemoryWorkspaceNav.tsx`
- Create: `apps/electron/src/renderer/components/memory/MemoryProjectSelector.tsx`
- Create: `apps/electron/src/renderer/components/memory/MemoryProjectOverview.tsx`
- Create: `apps/electron/src/renderer/components/memory/MemoryGlobalSettings.tsx`
- Create: `apps/electron/src/renderer/components/memory/MemoryExportView.tsx`
- Modify: `apps/electron/src/renderer/components/memory/MemoryView.test.tsx`
- Create: `apps/electron/src/renderer/components/memory/MemoryExportView.test.tsx`

- [ ] **Step 1: Write failing BDD component tests**

覆盖四个导航项、真实 `AgentWorkspace.name`、selector 切换、策略继承/覆盖展示，以及导出范围/格式/选项和成功保存行为：

```tsx
test('当前项目显示 name 而不是 slug，并可切换项目', () => {
  const html = renderMemoryWorkspace({
    workspaces: [workspace('project-a', 'Copis'), workspace('project-b', '另一个项目')],
    selectedWorkspaceId: 'project-a',
  })
  expect(html).toContain('Copis')
  expect(html).not.toContain('当前工作区：project-a')
  expect(html).toContain('当前项目')
  expect(html).toContain('全部项目')
  expect(html).toContain('全局设置')
  expect(html).toContain('导出记忆')
})

test('项目未设置 policy 时显示继承全局', () => {
  const html = renderMemoryWorkspace({
    workspaces: [workspace('project-a', 'Copis')],
    selectedWorkspaceId: 'project-a',
    defaultPolicy: 'visible',
  })
  expect(html).toContain('继承全局（只读）')
})

test('导出表单提交当前项目 Markdown 并调用本地保存', async () => {
  const exportResponse = {
    fileName: 'copis-memory-project-a.md',
    mimeType: 'text/markdown',
    content: '# Copis Memory Export',
    entryCount: 2,
    revisionCount: 0,
  }
  memoryApi.export = mock(async () => exportResponse)
  window.electronAPI.saveMemoryExport = mock(async () => true)
  render(<MemoryExportView workspaceSlug="project-a" />)
  await user.click(screen.getByRole('button', { name: '导出 Markdown' }))
  expect(memoryApi.export).toHaveBeenCalledWith({
    scope: 'current-workspace',
    workspaceSlug: 'project-a',
    format: 'markdown',
    includeArchived: false,
    includeHistory: false,
  })
  expect(window.electronAPI.saveMemoryExport).toHaveBeenCalledWith(exportResponse)
})
```

- [ ] **Step 2: Run focused renderer tests and verify they fail**

Run: `bun test apps/electron/src/renderer/components/memory/MemoryView.test.tsx apps/electron/src/renderer/components/memory/MemoryExportView.test.tsx`

Expected: FAIL because the new navigation/components and export view do not exist.

- [ ] **Step 3: Implement atoms and page shell**

增加 `memoryPageAtom`（`current`/`all`/`global`/`export`）、`memorySelectedWorkspaceIdAtom` 和导出表单 atoms。`MemoryView` 初次以当前 Agent workspace 作为 selector 默认值，selector 改变时只重置 Memory 条目、draft、history、maintenance 并按新 slug 重新加载；不把 slug 渲染成项目名称。当前项目内容继续复用 `MemoryList`、`MemoryEditor`、revision conflict 和原有筛选；没有 workspace 时只允许 user scope。

- [ ] **Step 4: Implement navigation, overview and global settings**

`MemoryWorkspaceNav` 只切换 page atom；`MemoryProjectSelector` 选项显示 `workspace.name`，value 使用 id；`MemoryProjectOverview` 使用现有 `memoryApi.stats(slug)` 展示 user/workspace/archived 数量和 maintenance 状态；全局设置读取/更新 `defaultMemoryPolicy`；当前项目 policy 控件显示：`继承全局`、`关闭`、`只读`、`可写`，继承调用 `updateAgentWorkspace(id, { memoryPolicy: null })`，其他选项调用实际策略。有效策略使用 workspace override > default > writable。

- [ ] **Step 5: Implement export page and local download**

`MemoryExportView` 提供范围（当前项目/全部项目/用户记忆）、格式（JSON/Markdown）、归档和历史选项，预览当前 scope 和 count，提交时调用 `memoryApi.export` 后 `window.electronAPI.saveMemoryExport`。导出成功只提示并保留选择，失败只提示中文错误，不清空当前页面筛选或 draft。当前项目范围没有 slug 时禁用提交并显示“请先选择项目”。

- [ ] **Step 6: Run focused BDD tests and renderer build**

Run: `bun test apps/electron/src/renderer/components/memory/MemoryView.test.tsx apps/electron/src/renderer/components/memory/MemoryExportView.test.tsx`

Expected: PASS。

Run: `bun run --filter='@copis/electron' build:renderer`

Expected: PASS。

### Task 5: 集成验证与差异检查

**Files:**
- Modify only memory implementation/test files from Tasks 1-4 as needed.
- Do not modify: `AGENTS.md`, `README.md`, functional-module/release files.

- [ ] **Step 1: Run all focused Memory tests**

Run:

```bash
bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts
bun test apps/electron/src/main/lib/memory-api-client.test.ts
bun test apps/electron/src/renderer/components/memory/MemoryView.test.tsx apps/electron/src/renderer/components/memory/MemoryExportView.test.tsx
cargo test --manifest-path native/http-api-server/Cargo.toml
```

Expected: all PASS。

- [ ] **Step 2: Run repository typecheck and builds**

Run: `bun run typecheck`

Run: `bun run --filter='@copis/electron' build:main`

Run: `bun run --filter='@copis/electron' build:preload`

Run: `bun run --filter='@copis/electron' build:renderer`

Expected: all PASS。

- [ ] **Step 3: Execute local HTTP/SQLite export smoke**

使用临时 `COPIS_CONFIG_DIR` 启动 Rust HTTP 服务，写入 user、project-a、project-b 三类数据，分别调用 `/api/memory/export` 的三种 scope，验证 JSON/Markdown 内容和 workspace 隔离；再通过 Electron 页面触发 JSON/Markdown Save As，确认数据库条目数量和 revision 未变化。

- [ ] **Step 4: Review diff and report residual risk**

Run: `git diff --check` and `git diff --stat`。

确认没有功能模块/发布链路变更、没有 slug 冒充项目名、没有新增 localStorage/数据库，并在交付中明确报告未执行或受环境影响的实际 Electron 窗口 smoke。
