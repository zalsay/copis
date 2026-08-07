# 专家团队本地 Rust API 与 Pi-only 执行计划

日期：2026-08-07

## 目标与边界

专家团队的定义、版本快照、工作区绑定和运行状态由本机 `copis-http-api-server` 独占保存。数据库使用 SQLite，不上传云端，也不由 Electron Renderer、Electron 主进程或 Pi worker 直接打开。

本阶段只负责可靠地创建、读取和更新运行记录，不在 Rust 中启动 Agent。公开创建接口只产生 `queued` run；后续执行层由 Electron 通过内部令牌调用状态写入 API，并使用 Copis Pi Agent 子会话执行节点。Rust API 不运行 Codex、bwrap 或其他外部 Agent runtime。

调用边界遵循 `ai-education` 的 Planner 模式：主 Agent 始终负责与用户对话，普通请求由主 Agent 直接完成；只有主 Agent 判断请求确实需要完整的“researcher → summary → reviewer”工作流时，才调用 `expert_team_run`。该工具读取 Rust 返回的冻结 schema revision，创建 queued run 并启动 Pi-only 子会话，节点结果只作为结构化工具结果回传主 Agent，由主 Agent 汇总后回复用户。delegation、automation 等子会话不注册该工具，专家团队工作台只查看 Schema、历史运行和产物。

## 实施阶段

1. **SQLite 初始化与迁移**
   - 使用 `COPIS_EXPERT_TEAMS_DIR` 作为目录；未设置时使用 `~/.copis/expert-teams/expert-teams.db`。
   - 自动创建目录，打开数据库后设置 `foreign_keys=ON`、WAL、`synchronous=NORMAL` 和 busy timeout。
   - migration 在事务中执行，并通过 `PRAGMA user_version` 管理版本。专家团队数据库与 `memory.db` 完全分离。
   - 打开数据库时确保 `ai-education-research-writer-reviewer`（展示名“深入研究团队”）内置模板存在：缺失时注入，已有 `source: copis-builtin` 且 `templateVersion < 2` 时通过新增不可变 revision 升级；同 ID 的用户自定义 schema 不覆盖，已有 v2 不重复发布。模板 DAG 为 `researcher -> summary -> reviewer`：`researcher` 搜集资料并输出 Markdown 资料文档，`summary` 将资料总结为 Markdown 文档，`reviewer` 检验任务结果并输出 Markdown 检验报告；元数据声明 `execution: pi-only` 和 `templateVersion: 2`。

2. **不可变 schema revision**
   - 发布 schema 时校验 1 至 32 个节点、节点 ID 唯一、角色仅为 `researcher`、`writer`、`reviewer`、`executor`。
   - 校验所有依赖存在且 DAG 无环；节点声明路径必须是工作区内的相对路径，拒绝绝对路径、反斜杠和 `..`。
   - 创建或更新同一 schema 都插入新的 `schema_revisions` 行。revision 快照使用规范化 JSON 并保存 SHA-256；已有 revision 永不覆盖。

3. **公开 HTTP API**

   | 方法 | 路径 | 说明 |
   | --- | --- | --- |
   | GET | `/api/expert-teams/schemas` | 返回 `{schemas: [...]}` |
   | POST | `/api/expert-teams/schemas` | 发布 schema，返回 `schemaRevisionId`、revision、sha256 |
   | GET | `/api/expert-teams/schemas/:id` | 返回 schema 元数据和全部 revisions |
   | POST | `/api/expert-teams/workspaces/:workspaceSlug/binding` | 绑定 schema；只传 `schemaId` 时使用当前 revision |
   | POST | `/api/expert-teams/runs` | 必须有 workspace slug；优先使用 `schemaRevisionId`/`schemaRevision`，也支持 schema 当前 revision 或 workspace binding；只创建 `queued` run |
   | GET | `/api/expert-teams/runs/:id` | 查询 run 与 revision 快照引用 |
   | GET | `/api/expert-teams/runs/:id/events` | 查询顺序事件 |
   | POST | `/api/expert-teams/runs/:id/cancel` | 将 queued run 变为 `cancelled` |
   | GET | `/api/expert-teams/runs/:id/artifacts` | 查询产物元数据 |

   输入字段使用 camelCase。错误沿用 Rust API 形状 `{error, code}`，校验、找不到、冲突和 SQLite 错误分别映射到 400、404、409、500。

4. **Electron 执行层内部 API**

   下列路径均要求 `X-Copis-Internal-Token` 与 `COPIS_HTTP_API_INTERNAL_TOKEN` 相同；Rust 只记录状态，不创建进程：

   - `POST /api/internal/expert-teams/runs/:id/claim`：`queued -> running`，重复 claim 允许幂等调用。
   - `POST /api/internal/expert-teams/runs/:id/events`：请求 `{nodeId, type, payload}`，按 run 生成单调 `seq`，保留 `nodeId`。
   - `POST /api/internal/expert-teams/runs/:id/nodes/:nodeId/start|complete|fail|cancel`：分别写入 `running`、`succeeded`、`failed`、`cancelled` 节点状态和时间戳；也支持无 action 的节点状态写入端点。
   - `POST /api/internal/expert-teams/runs/:id/artifacts`：请求包含 `nodeId`、相对 `path`、可选 64 位十六进制 `sha256` 与 `sizeBytes`；服务保存 artifact 元数据，不读取或复制文件。
   - `POST /api/internal/expert-teams/runs/:id/complete`：请求 `{status: "succeeded"|"failed"|"cancelled"}`，只允许 queued/running run 完成。

   Electron 的 `expert-team-runner` 负责 Pi 子会话调度、输出目录和文件 SHA-256；Rust 负责事务、状态顺序和持久化。不得把绝对路径写入 artifact API。

5. **验证与后续接入**
   - Rust 端覆盖 schema 校验、revision 不可变、workspace binding、queued/cancelled 生命周期、内部 node/action 路由和内置模板 seed。
   - Electron 执行层接入 claim、事件、节点、artifact、complete 接口后，再补 HTTP client smoke 与实际 Pi 子会话验收。
   - Rust API 不替代 Electron 的 Agent bridge；任何需要模型调用的节点必须由 Pi-only 执行层完成。
   - 主 Agent 专家团队工具必须在 user 主会话中可见，在 delegation/automation 子会话中不可见；重复 tool call 使用 `toolCallId` 幂等缓存，不能重复创建 run。

## SQLite 数据模型

- `schemas`：schema 标识、名称、描述、当前 revision 引用。
- `schema_revisions`：每次发布的 `revision`、完整 `snapshot_json`、`sha256` 和创建时间；`(schema_id, revision)` 唯一。
- `workspace_bindings`：工作区 slug 到不可变 `schema_revision_id` 的绑定。
- `runs`：工作区、schema revision、revision SHA-256、状态、输入和时间；运行保存 revision 快照 ID，不能只保存可变 schema ID。
- `run_nodes`：创建 run 时复制节点 ID、角色、依赖和节点快照；状态更新不改变 schema revision。
- `run_events`：run 内单调序号、事件类型、JSON payload 和时间。
- `run_artifacts`：节点产物的相对路径、大小、MIME、SHA-256 和时间，仅保存元数据。

所有写入使用同一 SQLite 连接的事务或受互斥保护的单次写操作，外键开启；删除 schema/revision 不通过本阶段 API 暴露，避免破坏运行历史。

## 完成标准

- `cargo test`（`native/http-api-server`）通过。
- `cargo fmt --all` 后工作区无 Rust 格式化差异。
- 公开 API 创建的 run 始终为 `queued`，数据库重启后 revision、节点快照、事件和产物元数据可读。
- 主 Agent 调度工具的结果回传、子会话可见性、DAG 执行器和前序产物目录均有聚焦测试覆盖。
- 无内部令牌时执行写入端点返回 `403 internal_token_required`。
- 真实 Electron 窗口和 Pi 子会话的 UI/视觉确认仍由用户执行；自动化测试不替代该确认。
