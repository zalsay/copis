# UI 文件树与文件处理 Rust HTTP API 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Electron Renderer 的文件树、文件搜索、文件读取/写入和文件管理操作迁移到类型化的 Rust HTTP API，同时保留文件选择框、Finder、Terminal 和默认应用等桌面原生能力。

**Architecture:** Renderer 通过 typed file API client 调用稳定的 /api/files/* 合约；第一阶段 Rust HTTP Server 通过受保护的业务桥调用抽出的 Electron 文件服务，保证行为先迁移，第二阶段将核心文件系统操作和路径授权下沉到 Rust。UI 不再调用文件数据 IPC，也不把 candidateBasePaths 当作授权来源。

**Tech Stack:** Bun、TypeScript、React、Jotai、Electron Preload、手写 Rust TCP HTTP Server、serde_json、Bun test、Rust cargo test。

---

## 1. 范围与当前事实

### 1.1 纳入范围

- 文件树：项目根、会话目录和已附加目录的懒加载列表、刷新、自动 reveal。
- 文件搜索：项目/会话/附加目录搜索，以及文件 mention 搜索。
- 文件内容：文本读取、Markdown 写入、图片/PDF/二进制读取。
- 文件管理：重命名、移动、删除，包含批量删除和跨卷移动语义。
- 预览：PDF、图片、DOCX、XLSX/PPTX 的 HTTP 入口。格式转换在 Rust 原生转换器完成前可通过 Rust route 桥接现有 Electron 转换服务。
- 错误、权限、服务启动、token 失效和文件变化后的刷新行为。

### 1.2 明确保留的 Electron 原生能力

- openFileDialog、openFolderDialog、openFileOrFolderDialog。
- openFile、showInFolder、showItemInFolder、openFolderInTerminal。
- systemOpenFile、scanEditors、getDefaultAppForFile。
- Electron webUtils.getPathForFile 和文件拖放取得本机路径。
- attach/detach workspace/session 文件或目录配置 IPC；文件树读取配置改走 Rust API。

### 1.3 现状锚点

- FileBrowser 在 apps/electron/src/renderer/components/file-browser/FileBrowser.tsx:195 直接调用 listDirectory、renameFile、moveFile、deleteFile。
- SidePanel 在 apps/electron/src/renderer/components/agent/SidePanel.tsx:882 使用另一套 listAttachedDirectory、renameAttachedFile、moveAttachedFile。
- FileSearchBar 和 file-mention-suggestion 直接调用 searchWorkspaceFiles。
- DiffTabContent 在 apps/electron/src/renderer/components/diff/DiffTabContent.tsx:632 调用 preparePdfPreview、resolveFilePath、docxToHtml、officeToHtml、resolveAndReadFile、writeTextFile。
- 文件数据 IPC handler 位于 apps/electron/src/main/ipc.ts:3271，路径策略位于 apps/electron/src/main/lib/file-access-policy.ts。
- Rust 当前在 native/http-api-server/src/main.rs:389 将普通 HTTP 请求通过 stdin/stdout 业务桥交给 Electron。
- http-api-bridge.ts 对未知方法返回空数组或 undefined；迁移后文件 API 不能继续静默降级。

## 2. 目标不变量

1. Renderer 只依赖文件 API DTO，不接触 Node fs、Rust 业务桥协议或配置文件。
2. /api/files/* 的 HTTP 路径和响应结构在过渡阶段与 Rust 原生阶段保持不变。
3. UI 传入的绝对路径只是候选目标，服务端必须结合 sessionId/workspaceSlug 重新解析授权根。
4. 文件内容读写不经过 Renderer 的 Electron IPC；桌面系统动作可以继续走 IPC。
5. 读请求可以有限启动重试；写、删、移、重命名不得无条件重试。
6. Rust 只监听 127.0.0.1；生产环境非 health 请求需要 Bearer token。
7. 保留当前目录、搜索深度和文件大小上限，避免 HTTP 迁移造成资源放大。

## 3. HTTP 合约

### 3.1 DTO 与错误

新增 packages/shared/src/types/file-api.ts：

    import type { FileEntry } from './agent'

    export interface FileApiContext {
      sessionId?: string
      workspaceSlug?: string
    }

    export interface FileApiPathRequest extends FileApiContext {
      path: string
    }

    export interface FileApiListResponse {
      entries: FileEntry[]
      truncated: boolean
    }

    export interface FileApiSearchRequest extends FileApiContext {
      workspaceRootPath: string
      query: string
      limit?: number
    }

    export interface FileApiReadTextResponse {
      resolvedPath: string
      content: string
      revision: string
    }

    export interface FileApiWriteTextRequest extends FileApiPathRequest {
      content: string
      expectedRevision?: string
    }

    export interface FileApiRenameRequest extends FileApiPathRequest {
      newName: string
    }

    export interface FileApiMoveRequest extends FileApiContext {
      path: string
      targetDir: string
    }

    export interface FileApiDeleteRequest extends FileApiContext {
      paths: string[]
    }

固定错误码：invalid_request、invalid_json、path_not_allowed、path_not_found、path_type_mismatch、file_name_invalid、name_conflict、write_conflict、file_too_large、directory_too_large、server_unavailable、file_api_unauthorized、internal_error。

### 3.2 路由

    POST /api/files/list
    POST /api/files/search
    POST /api/files/read-text
    POST /api/files/read-binary
    PUT  /api/files/text
    POST /api/files/rename
    POST /api/files/move
    POST /api/files/delete
    POST /api/files/preview/pdf
    POST /api/files/preview/docx
    POST /api/files/preview/office

路径放在 JSON body 中，避免绝对路径进入 URL 日志。read-binary 返回受限的二进制 HTTP body；Renderer client 转换为 Blob URL。预览 HTML 继续经过现有 DOMPurify 清洗。

### 3.3 限制和行为

- 单目录最多 2000 项；搜索最大递归深度 10、单来源 2000 项、总结果 3000 项。
- 普通二进制和预览输入最大 50MB；附加文件读取沿用当前 20MB 限制。
- 目录优先，同类按名称排序；项目树隐藏目录继续遵循 shouldShowProjectFileTreeEntry。
- rename 拒绝路径分隔符、空名称和 ..；同名返回 409 name_conflict。
- move 保留跨卷 copy+delete 语义，目标存在时拒绝覆盖。
- write-text 返回 revision；传入旧 revision 返回 409 write_conflict，不覆盖外部修改。
- 批量 delete 返回逐项结果，不能因为一项失败而重复执行已成功项。

## 4. 文件结构

### 新增

- packages/shared/src/types/file-api.ts：DTO、错误码、路径常量。
- apps/electron/src/renderer/lib/file-api-client.ts：HTTP、认证、错误解析、AbortController、Blob URL。
- apps/electron/src/main/lib/file-service.ts：从 ipc.ts 抽出的过渡文件服务。
- apps/electron/src/main/lib/file-service.test.ts：过渡服务行为测试。
- native/http-api-server/src/files/mod.rs：Rust route、DTO、错误响应。
- native/http-api-server/src/files/policy.rs：canonical path、symlink 和操作授权。
- native/http-api-server/src/files/service.rs：Rust list/search/read/write/rename/move/delete。
- native/http-api-server/src/files/tests.rs：Rust 文件服务和路径安全测试。
- apps/electron/src/renderer/lib/file-api-client.test.ts：client 契约测试。

### 修改

- packages/shared/src/index.ts、packages/shared/src/types/index.ts。
- apps/electron/src/main/lib/http-api-handler.ts、apps/electron/src/main/lib/http-api-server.ts。
- native/http-api-server/src/main.rs。
- apps/electron/src/preload/index.ts、apps/electron/vite.config.ts。
- apps/electron/src/renderer/components/file-browser/FileBrowser.tsx、apps/electron/src/renderer/components/file-browser/FileSearchBar.tsx、apps/electron/src/renderer/components/file-browser/file-mention-suggestion.tsx。
- apps/electron/src/renderer/components/agent/SidePanel.tsx、apps/electron/src/renderer/components/diff/DiffTabContent.tsx、apps/electron/src/renderer/components/diff/markdown-preview-extensions.tsx。
- apps/electron/src/renderer/lib/http-api-bridge.ts、apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts、apps/electron/src/renderer/components/ai-elements/file-path-chip.tsx、apps/electron/src/renderer/components/agent/tool-result-renderers/edit-result.tsx。
- apps/electron/package.json、packages/shared/package.json、bun.lock。
- README.md、AGENTS.md 仅在用户允许后同步。

## 5. 分阶段任务

### Task 1: 固化 DTO、client 和错误契约

**Files:**

- Create: packages/shared/src/types/file-api.ts
- Modify: packages/shared/src/types/index.ts, packages/shared/src/index.ts
- Create: apps/electron/src/renderer/lib/file-api-client.ts
- Test: apps/electron/src/renderer/lib/file-api-client.test.ts

- [ ] Step 1: 写失败测试，断言 list 使用 POST JSON、路径不在 URL，409 映射为带 code/status 的 FileApiError。
- [ ] Step 2: 运行 bun test apps/electron/src/renderer/lib/file-api-client.test.ts，确认因 client 和 DTO 不存在而失败。
- [ ] Step 3: 实现 request<T>、FileApiError、list/search/readText/readBinary/writeText/rename/move/delete/preview；组件不得重复 fetch。
- [ ] Step 4: 覆盖 2xx、400、401、403、404、409、413、503 和非 JSON body，运行同一测试并确认 PASS。
- [ ] Step 5: 提交以下已验证文件：

    git add packages/shared/src/types/file-api.ts packages/shared/src/types/index.ts packages/shared/src/index.ts apps/electron/src/renderer/lib/file-api-client.ts apps/electron/src/renderer/lib/file-api-client.test.ts
    git commit -m "feat: define file http api contract"

### Task 2: 建立本地 API 认证和 bootstrap

**Files:**

- Modify: apps/electron/src/main/lib/http-api-server.ts
- Modify: apps/electron/src/main/lib/http-api-handler.ts
- Modify: native/http-api-server/src/main.rs
- Modify: apps/electron/src/preload/index.ts
- Modify: apps/electron/vite.config.ts
- Test: apps/electron/src/main/lib/http-api-server.test.ts、native/http-api-server/src/main.rs

- [ ] Step 1: 写 Given/When/Then：无 Authorization 返回 401；错误 token 返回 401 且不触发 bridge；本地 Vite origin 和 production 无 Origin 通过；外部 Origin 返回 403。
- [ ] Step 2: 运行 bun test apps/electron/src/main/lib/http-api-server.test.ts && cargo test --manifest-path native/http-api-server/Cargo.toml，确认新场景失败。
- [ ] Step 3: 主进程用 crypto.randomBytes(32) 生成 token，通过 COPIS_HTTP_API_TOKEN 传给 Rust；开发模式写入权限 0600 的 runtime 文件。
- [ ] Step 4: Vite proxy 每次代理读取 runtime token 并注入 Authorization；Preload 增加 getLocalHttpApiBootstrap(): { baseUrl: string; token: string }，production Renderer 直连 127.0.0.1:51730。
- [ ] Step 5: Rust 对 health 保持匿名；其他路由比较 token，允许本地开发 origin、无 Origin 和 file Renderer 的请求，拒绝外部 origin。
- [ ] Step 6: 重新运行 Bun/Rust 测试，确认 PASS；提交 git commit -m "feat: secure local file http api"。

### Task 3: 抽取过渡 Electron 文件服务并挂载 routes

**Files:**

- Create: apps/electron/src/main/lib/file-service.ts
- Test: apps/electron/src/main/lib/file-service.test.ts
- Modify: apps/electron/src/main/ipc.ts、apps/electron/src/main/lib/http-api-handler.ts、native/http-api-server/src/main.rs

- [ ] Step 1: 把 LIST_DIRECTORY、SEARCH_WORKSPACE_FILES、DELETE_FILE、RENAME_FILE、MOVE_FILE、file:resolve-and-read、file:write-text、file:resolve-path、file:read-binary-base64 和预览入口的实际逻辑抽到 file-service.ts；原 IPC 仅代理 service。
- [ ] Step 2: 写临时目录测试：排序/隐藏目录、2000 项、深度 10、越界/symlink、重命名冲突、跨卷 fallback、批量删除、20MB/50MB 上限。
- [ ] Step 3: 运行 bun test apps/electron/src/main/lib/file-service.test.ts，确认实现前失败。
- [ ] Step 4: 在 http-api-handler.ts 注册 /api/files/*；handler 只解析 DTO、调用 service、映射 403/404/409/413/500，不能重复写 fs 逻辑。
- [ ] Step 5: Rust 保持透明 bridge 转发，并测试认证失败时不发送 bridge。
- [ ] Step 6: 用带 token 的 curl 请求 /api/files/list，确认响应字段与 FileEntry/旧 service fixture 等价；提交 git commit -m "feat: expose file operations through http api"。

### Task 4: 迁移文件树、搜索和 mention

**Files:**

- Modify: apps/electron/src/renderer/components/file-browser/FileBrowser.tsx
- Modify: apps/electron/src/renderer/components/file-browser/FileSearchBar.tsx
- Modify: apps/electron/src/renderer/components/file-browser/file-mention-suggestion.tsx
- Modify: apps/electron/src/renderer/components/agent/SidePanel.tsx
- Modify: apps/electron/src/renderer/lib/http-api-bridge.ts
- Create: apps/electron/src/renderer/components/file-browser/FileBrowser.test.tsx
- Create: apps/electron/src/renderer/components/file-browser/FileSearchBar.test.tsx

- [ ] Step 1: 写 BDD：展开目录只调用 fileApiClient.list；搜索只调用 fileApiClient.search；附加目录使用同一 context，不把 candidateBasePaths 当作授权根。
- [ ] Step 2: 运行对应 Bun 测试确认当前 IPC 调用导致失败。
- [ ] Step 3: 替换 list/rename/move/delete/search 调用；保留 showInFolder、openFolderInTerminal、openFile 等桌面原生调用。
- [ ] Step 4: 搜索用 AbortController 取消旧 query；503/token 失效显示错误而不是“目录为空”；mutation 成功后刷新当前根和已展开目录。
- [ ] Step 5: 删除 http-api-bridge.ts 中文件 API 的 ARRAY_DEFAULT_METHODS/通用 undefined fallback。
- [ ] Step 6: 运行 bun test apps/electron/src/renderer/components/file-browser/FileBrowser.test.tsx apps/electron/src/renderer/components/file-browser/FileSearchBar.test.tsx && bun run typecheck；确认 PASS 后提交 git commit -m "refactor: route file tree through http api"。

### Task 5: 迁移预览、媒体和 Markdown 写入

**Files:**

- Modify: apps/electron/src/renderer/components/diff/DiffTabContent.tsx
- Modify: apps/electron/src/renderer/components/diff/markdown-preview-extensions.tsx
- Modify: apps/electron/src/renderer/components/ai-elements/file-path-chip.tsx
- Modify: apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts
- Modify: apps/electron/src/renderer/components/agent/tool-result-renderers/edit-result.tsx
- Create: apps/electron/src/renderer/components/diff/file-preview-api.test.ts

- [ ] Step 1: 写 BDD：保存使用 PUT /api/files/text + revision；旧 revision 返回 409 且不覆盖；图片/PDF 通过 protected binary response 创建 Blob URL。
- [ ] Step 2: 运行 Bun 预览测试确认当前 Preload 调用导致失败。
- [ ] Step 3: resolveAndReadFile 改为 readText；resolveFilePath/readBinaryBase64 改为 readBinary；client 负责 Blob URL、大小限制和 URL 清理。
- [ ] Step 4: PDF/DOCX/Office 统一调用 preview route；第一阶段 route 可桥接 file-preview-service.ts，Renderer 不接触 Electron 临时路径。
- [ ] Step 5: Markdown 保存携带 expectedRevision；409 时保留草稿、停止自动保存并提供重新加载动作；成功后递增 diffRefreshVersion。
- [ ] Step 6: 运行 bun test apps/electron/src/renderer/components/diff/file-preview-api.test.ts && bun run --filter='@copis/electron' build:renderer；确认 PASS 后提交 git commit -m "refactor: route file preview through http api"。

### Task 6: Rust 原生路径策略和只读服务

**Files:**

- Create: native/http-api-server/src/files/mod.rs、policy.rs、service.rs、tests.rs
- Modify: native/http-api-server/src/main.rs
- Modify: apps/electron/src/main/lib/http-api-handler.ts
- Modify: apps/electron/src/main/lib/http-api-server.ts

- [ ] Step 1: 依赖评估：保持标准库和 serde_json；确实需要新 crate 时先 cargo search、读官方文档、验证 macOS/Windows 构建后再锁 Cargo.toml/Cargo.lock。本任务不引入 watcher crate。
- [ ] Step 2: 写 Rust 测试：授权根内通过；..、外部 symlink、root destructive operation 拒绝；missing target 仅按 existing parent 校验。
- [ ] Step 3: 运行 cargo test --manifest-path native/http-api-server/Cargo.toml，确认新测试失败。
- [ ] Step 4: policy.rs 实现 existing path realpath、missing target existing-parent、source/target 分别校验和固定错误码。
- [ ] Step 5: service.rs 实现 list/search/read-text/read-binary，保留排序、隐藏目录、深度、数量和大小限制；revision 固定为文件 size 与 modified time 的纳秒级组合，文件系统不提供纳秒时使用 seconds+nanos 字段序列化，测试覆盖外部修改后的 revision 变化。
- [ ] Step 6: 增加内部 /api/internal/files/authorize：Rust bridge 携带内部标记请求 Electron 解析 session/workspace/attached roots；普通 HTTP 客户端不能访问此 route。
- [ ] Step 7: Rust 直接处理 list/search/read；Electron bridge 只返回授权 metadata，过渡 file-service 仍供旧 IPC 和格式转换使用。
- [ ] Step 8: 运行 cargo test --manifest-path native/http-api-server/Cargo.toml && bun test apps/electron/src/main/lib/file-service.test.ts apps/electron/src/main/lib/http-api-server.test.ts；确认临时目录结果与旧 fixture 一致后提交 git commit -m "feat: implement rust file read api"。

### Task 7: Rust mutation、revision 冲突和通知

**Files:**

- Modify: native/http-api-server/src/files/service.rs、mod.rs、main.rs
- Modify: apps/electron/src/main/lib/http-api-handler.ts
- Modify: apps/electron/src/renderer/lib/file-api-client.ts
- Modify: apps/electron/src/renderer/components/file-browser/FileBrowser.tsx
- Modify: apps/electron/src/renderer/components/agent/SidePanel.tsx
- Test: native/http-api-server/src/files/tests.rs
- Test: apps/electron/src/renderer/lib/file-api-client.test.ts

- [ ] Step 1: 写 BDD：同名 move/rename 返回 409 且源不变；旧 revision 写入返回 409；批量 delete 返回逐项结果；跨卷 move 保留 copy+delete。
- [ ] Step 2: 运行 cargo test 确认新 mutation 场景失败。
- [ ] Step 3: 实现 Rust write/rename/move/delete；校验完成后只执行一次副作用，禁止覆盖目标；跨卷删除失败返回 partial_move_error。
- [ ] Step 4: 保留现有 Electron WORKSPACE_FILES_CHANGED 作为 invalidation-only 过渡；Renderer 收到事件后重新请求 Rust，不推送文件内容。
- [ ] Step 5: UI 区分 name_conflict、write_conflict、path_not_allowed、server_unavailable，批量操作只刷新受影响根。
- [ ] Step 6: 运行 cargo test --manifest-path native/http-api-server/Cargo.toml && bun test apps/electron/src/renderer/lib/file-api-client.test.ts；确认 PASS 后提交 git commit -m "feat: move file mutations into rust api"。

### Task 8: 清理旧文件数据 IPC、版本和文档

**Files:**

- Modify: apps/electron/src/main/ipc.ts
- Modify: apps/electron/src/preload/index.ts
- Modify: apps/electron/src/renderer/lib/http-api-bridge.ts
- Modify: packages/shared/src/types/agent.ts、apps/electron/package.json、packages/shared/package.json、bun.lock
- Modify: README.md、AGENTS.md（需用户授权）

- [ ] Step 1: 运行残留扫描：

    rg -n "window\\.electronAPI\\.(listDirectory|listAttachedDirectory|searchWorkspaceFiles|resolveAndReadFile|writeTextFile|resolveFilePath|readBinaryBase64|renameFile|moveFile|deleteFile)" apps/electron/src/renderer

  Expected: FileBrowser、SidePanel、FileSearchBar、mention、DiffTabContent 和 media extension 不再命中。
- [ ] Step 2: 确认所有 Renderer consumer 已迁移后，删除文件数据 IPC channel、Preload 类型和 handler；保留桌面原生动作、attach/detach 配置和必要的 Agent 兼容服务。
- [ ] Step 3: 删除浏览器模式的文件 API 空数组/undefined fallback，服务不可用统一抛 FileApiError。
- [ ] Step 4: 修改 shared DTO 时递增 shared patch；修改 Electron 时递增 electron patch；同步 bun.lock。
- [ ] Step 5: 取得用户允许后同步 README.md/AGENTS.md，只记录新的 Rust API、开发代理和 IPC 边界。
- [ ] Step 6: 运行 git diff --check 和残留扫描，确认只剩预期的桌面原生调用后提交 git commit -m "chore: remove legacy file data ipc"。

### Task 9: 集成验证和真实窗口验收

**Files:**

- Verify: all files in Tasks 1-8, Rust binary and packaged Electron app

- [ ] Step 1: 运行聚焦测试：

    bun test apps/electron/src/main/lib/file-access-policy.test.ts
    bun test apps/electron/src/main/lib/file-tree-filter.test.ts
    bun test apps/electron/src/main/lib/file-service.test.ts
    bun test apps/electron/src/main/lib/http-api-server.test.ts
    bun test apps/electron/src/renderer/lib/file-api-client.test.ts
    cargo test --manifest-path native/http-api-server/Cargo.toml

  Expected: 全部 PASS。
- [ ] Step 2: 运行构建：

    bun run typecheck
    bun run --filter='@copis/electron' build:main
    bun run --filter='@copis/electron' build:preload
    bun run --filter='@copis/electron' build:renderer
    bun run --filter='@copis/electron' build:http-api-server

  Expected: TypeScript、主进程、Preload、Renderer 和 Rust binary 均成功。
- [ ] Step 3: 启动 Electron 后用 token 请求 /api/files/list，验证正确 token 返回 FileEntry，缺 token/错误 token/越界路径分别返回 401/401/403。
- [ ] Step 4: 在真实 Electron 窗口展开项目、会话、附加目录；执行搜索、自动 reveal、文本预览、图片/PDF 预览、Markdown 保存、重命名、移动和删除。Network 中应看到 /api/files/*，不应看到文件数据 IPC。
- [ ] Step 5: 停止 Rust 后刷新文件树，验证显示服务不可用而不是“目录为空”；验证 Finder/Terminal/默认应用按钮仍可用。
- [ ] Step 6: 运行 bun run --filter='@copis/electron' electron-builder --dir，验证 packaged file:// Renderer 通过 Preload bootstrap 直连 Rust，token 不出现在 DOM 或日志。
- [ ] Step 7: 最终运行 git diff --check，并重新扫描 Renderer 文件数据 IPC；只允许本计划涉及文件、版本和锁文件出现在 diff 中。

## 6. 完成标准

- 文件树、搜索、文件 mention、预览读取和 Markdown 写入均通过 /api/files/*。
- Rust 直接执行 list/search/read/write/rename/move/delete；Electron bridge 只保留授权 metadata、格式转换过渡和桌面原生能力。
- 路径授权经过 session/workspace 服务端解析；symlink、越界、授权根 destructive operation 均拒绝。
- revision 冲突返回 409；mutation 没有危险的无条件重试。
- 浏览器和 Electron 模式对服务不可用、token 失效、路径越界显示稳定错误，不再静默返回空数据。
- 原有排序、懒加载、附加目录、自动 reveal、批量删除和跨卷移动行为保持一致。
- 聚焦测试、cargo test、typecheck、主进程/Preload/Renderer/Rust 构建和真实 Electron smoke 全部通过。
- README.md 和 AGENTS.md 仅在用户允许后同步，不保留过时的文件 IPC 架构描述。

## 7. 执行注意事项

- 当前工作树存在大量未提交改动；每个 Task 只 stage 自己的文件，不使用 git reset --hard 或 git checkout --。
- 两阶段必须保持同一 HTTP DTO；先完成 UI 迁移，再切换 Rust native implementation，便于逐路由回滚。
- 预览格式转换是跨语言风险最高的部分；Rust route + Electron conversion bridge 是明确过渡，不得把转换失败伪装成文件不存在。
- 文件变化通知只做 invalidation；Renderer 收到事件后重新请求 Rust API，不推送文件内容。
