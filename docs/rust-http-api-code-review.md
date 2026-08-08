# Copis Rust HTTP API 代码审查报告

## 1. 审查概述

| 项目 | 内容 |
|------|------|
| 审查对象 | `native/http-api-server`（`copis-http-api-server` v0.1.8） |
| 代码规模 | 审查时：7 个源文件约 10,250 行 Rust（含测试）；修复后：生产代码 8,637 行 + 独立测试文件 2,333 行（测试已拆分，见 7.5） |
| 审查基线 | `158a6429`（feat: complete browser automation and expert team workflows） |
| 审查日期 | 2026-08-07 |
| 审查方法 | 全量通读 + `cargo check --locked` + `cargo test` + `cargo clippy --all-targets` 静态检查 |
| 验证结果（审查时） | 编译通过；75 个测试全部通过；clippy 59 条告警（`-D warnings` 下构建失败） |
| 验证结果（修复后 2026-08-08） | `cargo test --locked` 87 passed / 0 failed；`cargo clippy --all-targets -- -D warnings` 0 告警；Electron `typecheck` 通过；相关 8 个测试文件 42 用例全部通过 |

### 模块清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/main.rs` | 2304（审查时 2381） | 手写 HTTP/1.1 服务器、Electron stdin/stdout 业务桥、路由分发、录制 JSONL、Agent SSE 流 |
| `src/memory.rs` | 2116（审查时 2634） | 记忆系统（SQLite，capture/recall/context/rewrite/export/维护） |
| `src/expert_teams.rs` | 1256（审查时 1466） | 专家团队 schema/run 状态机（SQLite） |
| `src/skill_market.rs` | 1172（审查时 1383） | Working 技能市场（远端 API 代理、ZIP 安装、本地状态管理） |
| `src/agent_files.rs` | 655（审查时 889） | Pi 文件能力令牌与受控文件读写（路径/符号链接/权限模式） |
| `src/pi_rpc.rs` | 560（审查时 771） | Pi Worker 生命周期（spawn/stop/queue/状态）、SSE 帧格式 |
| `src/runtime.rs` | 574（审查时 726） | 外部 Node/Git/Git Bash runtime 探测、缓存、PATH 注入 |

> 模块清单行数为修复 + 测试拆分后的当前生产代码行数；各文件的单元测试已移至独立的 `*_tests.rs` 文件（`main_tests.rs` 399 行、`memory_tests.rs` 557 行、`expert_teams_tests.rs` 368 行、`skill_market_tests.rs` 412 行、`agent_files_tests.rs` 234 行、`pi_rpc_tests.rs` 211 行、`runtime_tests.rs` 152 行），生产行号引用不受影响（测试代码原本就在文件末尾）。

### 总体结论

- 代码整体质量较高：SQL 全部参数化；路径穿越、ZIP 解压、符号链接、大小上限、revision 冲突等防护到位；错误信息统一为中文结构化 JSON；单元测试覆盖了关键安全边界。
- 最需要优先处理的是**认证缺失 + `Origin: null` CORS 回显**组合问题：除 `/internal/*` 与 skill-market 外，记忆、专家团队、Agent 生命周期接口均无认证，任意网页可通过沙箱 iframe 读取本地数据并触发本地操作（详见 §2.1）。
- 其次是有两个明确的逻辑缺陷：`memory.stats` 只统计最近 50 条导致统计失真；`expert_teams.resolve_revision` 把「版本号」与「revision 自增 ID」合并为一个字段且带跨 schema 的 id 回退。
- 并发模型（每连接一线程 + 无超时）与 Bridge 无限等待在本地单用户场景可接受，但值得加固。

## 2. 按严重程度分级的问题清单

### 2.1 高危（安全）

#### H1. 非内部接口无认证，且对 `Origin: null` 回显 CORS，任意网页可读写本地数据（✅ 已修复）

- 位置：`main.rs:1035-1160`（路由分发）、`main.rs:1478-1486`（`is_allowed_origin`）、`main.rs:2005-2030`（`send_response` 回显 `Access-Control-Allow-Origin`）、`pi_rpc.rs:90-101`（SSE CORS）。
- 现象：`/api/memory*`、`/api/expert-teams*`、`/api/agent/.../status|stop|queue|messages`、`/api/agent/workers/stop-all`、`/api/runtime/*` 均不需要任何令牌。服务器允许 `Origin: null`，并把 `Access-Control-Allow-Origin: null` 回显给浏览器。
- 攻击面：恶意网页用 `<iframe sandbox="allow-scripts">` 产生 opaque origin（`Origin: null`），其中的脚本可以：
  - `GET http://127.0.0.1:51730/api/memory?workspaceSlug=...` 读取全部记忆条目（无自定义 header 的简单请求，无预检）；
  - `POST /api/agent/workers/stop-all`、`POST /api/agent/sessions/{id}/stop` 停止正在运行的 Agent（简单请求直接生效，本地 DoS）；
  - 读取专家团队 schema/run 信息与运行时路径。
- 风险等级：高。虽然服务只监听 127.0.0.1，但浏览器访问不受此限制。
- 建议（按顺序）：
  1. 所有非 `/internal/*` 的状态读取与变更接口要求 `x-copis-internal-token`（或单独的随机会话令牌）；
  2. 不再对 `Origin: null` 回显 `Access-Control-Allow-Origin`（或只对明确白名单的 Vite 开发端口回显）；
  3. 对写操作额外校验 `Sec-Fetch-Site: same-origin`/`none`，或要求自定义请求头（触发预检并由服务端拒绝）。

**修复记录（2026-08-08）**：
- `main.rs` 路由分发前新增 web 令牌 gate：有 Origin 的浏览器请求必须携带 `x-copis-web-token`（同时接受 internal token）；`/internal/*`、`/api/internal/*`、`/api/health` 豁免；无 Origin 的本地进程请求（Pi Worker、Electron 主进程）放行；Vite 开发来源（`127.0.0.1:5174`/`localhost:5174`）豁免。
- 保留 `Origin: null` 的 ACAO 回显（打包 renderer 依赖该行为），但 `Origin: null` 请求同样必须携带 web 令牌。
- CORS `Access-Control-Allow-Headers` 加入 `x-copis-web-token`（`main.rs` 与 `pi_rpc.rs` SSE 响应）。
- Electron 侧：主进程随机生成 32B hex token（`http-api-web-token.ts`），spawn 时注入 `COPIS_HTTP_API_WEB_TOKEN`；6 个窗口通过 `additionalArguments` 注入 `--copis-http-api-web-token=`；`preload` 新增 `getHttpApiWebToken`；渲染层 `withHttpApiWebToken()` 已接入 5 个 HTTP 客户端（memory/expert-team/working-skill-market/file-api/agent-http-stream/http-api-bridge）。
- 新增 3 个 Rust gate 单测 + Electron 客户端相关测试。

#### H2. `is_internal_token_valid` 使用非恒定时间比较（✅ 已修复）

- 位置：`main.rs:886-894`。
- 现象：令牌比较用 `received == &expected`，理论上可侧信道逐字节猜测。本地 127.0.0.1 场景影响有限，但令牌是唯一防线，建议改为恒定时间比较（`agent_files.rs` 已有 `tokens_equal`，可复用同款实现）。

**修复记录（2026-08-08）**：`agent_files.rs::tokens_equal` 改为 `pub(crate)` 复用；`is_internal_token_valid` 与 `is_web_token_valid` 均改用恒定时间比较。新增单测 `internal_token_uses_constant_time_comparison`。

### 2.2 中危（正确性）

#### M1. `memory.stats` 只统计最近 50 条，总数失真（✅ 已修复）

- 位置：`memory.rs:921-940`。
- 现象：`stats()` 调用 `self.list(..., MAX_LIST_LIMIT)`，而 `list()` 内部先 `entries.truncate(limit)` 再返回；当条目数超过 50 时，`user_count / workspace_count / archived_count` 只基于最新 50 条计数，结果不准确。
- 建议：改为 `SELECT COUNT(*) ... GROUP BY` 直接统计，或使用不受 `MAX_LIST_LIMIT` 限制的内部查询。

**修复记录（2026-08-08）**：`stats()` 改为 `SELECT SUM(CASE ...)` 直接聚合，保持原有可见性过滤（无 workspace 时仅 user scope）。新增单测 `stats_统计全部条目不受列表返回上限影响`（60 条 + 归档 + user 条目验证）。

#### M2. `resolve_revision` 混淆「schema 版本号」与「revision 自增 ID」（✅ 已修复）

- 位置：`expert_teams.rs:780-825`，调用入口 `bind_workspace`/`create_run` 中 `input.schema_revision_id.or(input.schema_revision)`。
- 现象：
  - `schemaRevision`（版本号）与 `schemaRevisionId`（自增 ID）被合并成同一个 `i64`，调用方无法同时表达「某个 schema 的某个版本号」之外的语义，两个字段同时传时只能取其一；
  - 当 `(schema_id, revision)` 组合查不到时，回退到 `WHERE id = ?`（`expert_teams.rs:811-815`）。`id` 是全表自增，可能命中**其他 schema** 的 revision，导致 run 意外绑定到错误的 schema。
- 建议：拆分 `schema_revision`（版本号）与 `schema_revision_id`（自增 ID）两个独立查询参数，去掉按 id 的隐式回退，或对回退结果校验 `schema_id` 一致性。

**修复记录（2026-08-08）**：`resolve_revision` 拆分为 `revision_id` + `revision` 两个参数：
- `schemaRevisionId` 按 `id` 精确查询；同时提供 `schemaId` 时校验 `schema_id` 一致，跨 schema 引用返回 NotFound；
- `schemaRevision`（版本号）必须搭配 `schemaId` 按 `(schema_id, revision)` 查询，不再按 id 隐式回退；单独传版本号返回 Validation 错误；
- 仅传 `schemaId` 时仍使用该 schema 的当前 revision（原有语义保留）。
- 新增 3 个单测：跨 schema 拒绝、版本号按 schema 限定、仅 schemaId 使用当前 revision。`expert-team-agent-tool.ts` 发送 `schemaRevisionId` 的调用不受影响。

### 2.3 中危（健壮性/并发）

#### R1. Bridge 请求无限等待，无超时（✅ 已修复）

- 位置：`main.rs:72-105`（`send_request` 中 `receiver.recv()`）。
- 现象：每个 HTTP 请求经 Bridge 转发给 Electron 后无限阻塞；若 Electron 端丢失响应且 stdin 未触发 EOF（`fail_all` 未执行），请求线程永久挂起，`pending` map 条目泄漏。
- 建议：`recv_timeout(Duration)`，超时后移除 pending 条目并返回 504/503。

**修复记录（2026-08-08）**：`send_request` 改用 `recv_timeout`（默认 60s，`COPIS_HTTP_API_BRIDGE_TIMEOUT_MS` 可覆盖），超时移除 pending 条目；桥接主分发处超时返回 504 `bridge_timeout`，其余错误仍为 503 `bridge_unavailable`。新增单测 `bridge_request_times_out_and_cleans_pending`。

#### R2. 每连接一线程、无读超时、无并发上限（✅ 已修复）

- 位置：`main.rs:2166-2178`（`listener.incoming()` + `thread::spawn` 处理连接）、`main.rs:130-155`（请求读取无超时）。
- 现象：慢速/半开连接会长期占用线程（每个线程默认 2MB 栈），本地恶意进程可轻易打满；请求头/体读取也没有超时（slowloris 变体）。
- 建议：为连接读取加超时（`read_timeout`）、限制最大并发连接数，或改用线程池。

**修复记录（2026-08-08）**：`handle_connection` 设置 `set_read_timeout`（默认 30s，`COPIS_HTTP_API_READ_TIMEOUT_MS` 可覆盖）；`main()` 新增 `MAX_CONCURRENT_CONNECTIONS=64` 上限与 `ConnectionCountGuard`（线程退出自动减计数，panic 也不泄漏）。新增单测 `slow_connection_is_closed_by_read_timeout`（真实 TCP + 临时存储）。

#### R3. Agent SSE 客户端断开后 worker 不取消，线程继续占用（✅ 已修复）

- 位置：`main.rs:1665-1760`（`handle_agent_stream`）。
- 现象：`send_sse_frame` 的错误全部 `let _` 忽略；客户端断开后循环仍阻塞在 `worker.read_line()` 直到 run 自然结束，期间连接线程与 worker 持续占用资源。
- 建议：检测写失败后主动向 worker 发送 stop 并 `finish()`，或至少记录日志；若「断开后 Agent 应后台继续」是有意设计，需在文档中明确并限制并发。

**修复记录（2026-08-08）**：`handle_agent_stream` 中 `event`/`error`/`fatal` 帧发送失败或 worker 读取失败时，记录日志、调用 `workers.stop(session_id)` 并向 worker 发送 stop 命令后退出循环，随后 `finish()` 回收；`complete` 帧发送失败不额外 stop（run 已结束）。

#### R4. Bridge `available` 一旦置 false 永不恢复

- 位置：`main.rs:97,108`。
- 现象：任何一次 stdout 写失败都会永久标记桥不可用，之后所有桥接请求返回 503，直到进程重启。若 Electron 侧是瞬时失败（如管道背压），服务会长期不可用。
- 建议：确认 Electron 侧契约（写失败即桥损坏则保留现状，否则支持恢复探测）。

### 2.4 低危（代码质量/一致性）

| 编号 | 位置 | 问题 |
|------|------|------|
| L1 | `main.rs:489-525` | `parts[0] == *id`（`id = &parts[0]`）恒为真，冗余条件，疑似误写残留，应删除（✅ 已删除） |
| L2 | `main.rs:130-155` | `read_until` 先读 8KB 再判上限，header 上限存在约 8KB 超量窗口；可先检查再读 |
| L3 | `expert_teams.rs:689-717` | `update_run_node` 不校验 run 状态，已完成的 run 仍可更新节点状态 |
| L4 | `skill_market.rs:318-330` | 先调远端安装成功、本地安装失败时不会回滚远端安装状态，两端状态可能不一致（✅ 已修复） |
| L5 | `skill_market.rs:951-975` | `format_generated_skill_markdown` 用 `{:?}` 生成 YAML 值，特殊字符时可能产生非标准 YAML frontmatter |
| L6 | `runtime.rs:440-460` | `runtime_path` 把外部 runtime 目录前置到 PATH，会覆盖同目录名的系统命令；属设计决策，建议在文档中声明 |
| L7 | `main.rs:1985-1991` | 服务端对响应 `reason_phrase` 不全（如 202/405 返回 "HTTP Response"），本地场景可接受 |
| L8 | 全局 | `Mutex::lock().unwrap()` 在锁中毒时会 panic；本地单进程可接受，但可统一降级为错误返回 |

## 3. 分模块详细分析

### 3.1 `main.rs` — HTTP 服务器、业务桥与路由

做得好的方面：

- 手写 HTTP/1.1 解析器对 `Content-Length` 与 `Transfer-Encoding: chunked` 都做了 `MAX_REQUEST_BODY_BYTES`（约 50.25 MB）上限；chunk 大小、终止符、trailer 都有校验。
- `read_until` 对 header（64 KB）与行（64 KB）上限控制有效；`find_subslice` 为线性扫描，无需额外依赖。
- URL 解码（`decode_url_component`）拒绝非法 `%` 编码与非 UTF-8，`+` 语义按查询/路径区分。
- 录制 JSONL：`is_safe_path_component` 白名单 + `create_new` 防覆盖 + 行内容/大小/文件大小上限 + 每文件互斥锁，防护完整。
- 内部令牌只用于 `/internal/*` 与 Working 认证；`configure_worker_file_capability`（`pi_rpc.rs:542-546`）主动移除全局内部令牌、只向 Pi 注入会话级文件令牌，隔离设计正确。
- 错误响应统一为 `{error, code}` 中文结构，`escape_json_string` 防注入。

需要关注的点：

- 认证与 CORS 问题（H1）覆盖本模块的大部分路由。
- 路由匹配顺序：`/api/agent/...` 的 messages/queue 路由把原始请求体透传给 Electron 的 prepare 接口，由 Electron 决定最终配置；Rust 侧对 body 结构只做「必须是 JSON 对象」校验，属可信桥接设计。
- `/api/health` 的 `schemaVersion` 为硬编码 1，与 `memory.rs SCHEMA_VERSION`、`expert_teams.rs migrate` 的 `user_version=1` 一致，但存在漂移风险。
- `read_bridge_responses` 在 stdin EOF 时 `process::exit(0)`：整进程退出依赖「stdin 关闭 = Electron 桥死亡」契约，需与启动方确认。

### 3.2 `pi_rpc.rs` — Pi Worker 生命周期

- 启动流程完整：先 `register_from_query` 从配置中取走文件策略并生成会话令牌（配置中不再残留策略），再校验权限模式一致性、探测 runtime、spawn 子进程、注册到 `workers` map，最后发送 `run` 命令；失败路径会清理文件策略并 kill 子进程。
- `resolve_worker_launch` 严格区分「打包组合二进制（`__pi-worker`）」与「JS Worker（Bun/Node）」；`worker_requires_node` 与 `validate_for_worker` 保证开发模式不回退到托管 Node、打包模式找不到组合二进制时报中文错误。
- `stop`/`stop_all`/`set_permission_mode` 通过 stdin 写 JSONL 命令，`mark_stopping` 同步状态；`finish` 清理 workers/status/policy 并回收子进程。
- 关注点：
  - `start` 在 spawn 子进程之后才检查「同 session 已存在 worker」，重复请求会先 spawn 再 kill，存在短暂浪费与竞态窗口；建议先检查再 spawn。
  - `worker_statuses` 与 `workers` 两个 map 非原子更新，极端并发下 `session_status` 可能短暂不一致（本地低风险）。
  - `stop` 只发命令不等待 worker 退出，读取线程会阻塞到 run 结束；与 R3 关联。

### 3.3 `runtime.rs` — 外部 runtime 探测

- `thread::scope` 并行探测 node/git/bash，10 秒硬超时 + 轮询，20ms 间隔合理；30 秒缓存 TTL 与 `COPIS_RUNTIME_ROOT` 变更感知做得正确。
- `active_runtime_dir` 对 `current-version.txt` 做了 `is_safe_version`（拒绝 `.`/`..`/斜杠），防目录穿越。
- `inject_pi_config` 注入 `PATH`/`COPIS_*` 环境与 shellKind，Windows git-bash 分支处理完整。
- 关注点：`runtime_roots` 硬编码了 ai-education 的 AppData 目录（有注释说明复用）；`status_json` 中 bun/WSL 为固定不可用，属于当前架构声明。

### 3.4 `agent_files.rs` — Pi 受控文件访问（安全重点）

- `absolute_without_parent` 逐组件拒绝 `..`，相对路径基于 base_dir 解析。
- 双重符号链接防护：目标本身 + `has_symlink_component_below_roots` 检查授权根目录之下的每个组件；写路径在 `create_dir_all` 后二次 resolve 并比对，尽量压缩 TOCTOU 窗口。
- `ensure_write` 在 plan 模式只允许 `.md` 扩展名；`bypassPermissions`/`plan` 两种模式由 Rust 侧强制执行（`pi_rpc.rs` 注释明确：Worker 仅收状态同步命令）。
- 读/写大小上限（50 MB）、`expected_revision` 基于 SHA-256 内容校验、`atomic_write`（临时文件 + rename + fsync）均有实现。
- 客户端无法通过请求体提交 `readRoots/readFiles/writeRoots`（显式拒绝）。
- 关注点：
  - `tokens_equal` 是恒定时间比较，很好；但 `main.rs` 的内部令牌比较（H2）没有复用。
  - `has_symlink_component_below_roots` 依赖 `fs::canonicalize(&current)` 与授权根目录比较，根目录本身位于符号链接之下（如 macOS 的 `/tmp -> /private/tmp`）时能正确匹配 canonical 根，之后才启用符号链接检查，逻辑正确。
  - 剩余 TOCTOU（resolve 与 rename 之间目录被替换）在本地单用户场景可接受。

### 3.5 `memory.rs` — 记忆存储

做得好的方面：

- SQL 全部参数化；`MemoryStore` 用 `Mutex<Connection>` 串行化，`TransactionBehavior::Immediate` 避免写倾斜；WAL + `synchronous=NORMAL` + busy_timeout 配置合理。
- 可见性模型清晰：`workspace_slug` 提供时可见「user + 该 workspace」，否则只可见 user；查询/改写/归档都带 scope 过滤，`maintenance_entry` 再强制 workspace 归属。
- 输入校验完整：title/content/tags 长度与数量上限、`workspaceSlug` 字符白名单、limit 上限、revision 乐观锁（`expected_revision` 冲突返回 409 + 当前条目）。
- 去重按「规范化内容 + 同 scope」判定，事务内完成；scratch 维护计数、过期归档、promote/consolidate 都在同一事务内提交。
- 旧版 `entries.json`/`revisions.jsonl` 一次性迁移，用 `legacy_imported_at` 防止重复导入（有测试覆盖）。
- 导出 JSON/Markdown 分组完整，文件名组件做了 sanitize。

需要关注的点：

- `stats` 截断问题（M1）。
- `list` 在 Rust 侧全量扫描 + 内存过滤，O(n)；本地规模可接受，但 `matches_query` 对每条记录重复 `normalize_for_match`，条目多时偏慢。
- `find_duplicate` 同样全表扫描，O(n)。
- `export` 的 `AllWorkspaces` 可导出所有工作区数据，与 H1 组合时影响面更大。
- `query_entry_*` 在 `workspace_slug=None` 时只允许 user scope 条目，符合模型。

### 3.6 `expert_teams.rs` — 专家团队状态机

- schema 校验（1-32 个节点、角色白名单、节点 id 唯一、依赖存在、DFS 三色环检测）实现正确；`validate_relative_path` 对绝对路径、`..`、Windows 盘符、NUL 都做了拒绝。
- revision 不可变快照 + SHA-256 + `current_revision_id` 指针，历史可追溯；内置 schema 按 `templateVersion` 自动升级且不覆盖用户自定义（有测试）。
- run 状态机（queued→running→succeeded/failed/cancelled）与 `run_events` 顺序号（`MAX(seq)+1`）在全局 Mutex 下安全。
- 内部执行接口（claim/events/nodes/artifacts/complete）要求内部令牌。
- 关注点：`resolve_revision` 语义混淆（M2）；`update_run_node` 不校验 run 状态（L3）；`cancel_run` 对已 cancelled 幂等。

### 3.7 `skill_market.rs` — Working 技能市场

- 路由/参数校验严格：`validate_skill_slug`（小写字母数字 + 单连字符）、`validate_workspace_slug` 白名单、`percent_decode` 非法编码拒绝。
- ZIP 解压防护完整：拒绝绝对路径/`..`/反斜杠穿越（`normalize_archive_entry` + `Component` 二次检查）、拒绝符号链接条目、拒绝重复路径、声明大小与解压总量双重上限（20 MB 包 / 50 MB 解压 / 512 文件）、`create_new` 防覆盖。
- 安装过程：workspace+skill 粒度互斥锁；先备份现有目录，`rename` 原子替换，失败回滚并清理临时目录；`.market.json` 记录来源元数据。
- 下载校验：仅 HTTPS（或本地回环 HTTP）、大小 + SHA-256 双重校验、30 秒超时、响应体 10 MB 上限。
- 后端错误透传（非 2xx 保留状态码与 `error/code`），`unwrap_data` 兼容 `{data:...}` 包装。
- 关注点：`download_archive` 允许 `http://127.0.0.1|localhost|::1`，若后端被攻破可对本地服务 SSRF（低-中风险）；远端已安装而本地安装失败不回滚（L4）；`format_generated_skill_markdown` 的 YAML 转义（L5）。

## 4. 构建与测试验证

在 `native/http-api-server` 目录执行（rustc/cargo 1.97.1）：

```bash
cargo check --locked        # 通过
cargo test --locked         # 75 passed; 0 failed
cargo clippy --all-targets  # 59 条告警，-D warnings 下失败
```

clippy 告警构成：

- `result_large_err` × 53：`MemoryError` 最大变体（`Conflict(MemoryEntry)`）约 176 字节，建议对 `MemoryEntry`/`MemoryMaintenanceState` 装箱（`Box`）；
- `ptr_arg` × 2：`recording_lock(bridge, &PathBuf)`（`main.rs:806`）、`path_string(&PathBuf)`（`runtime.rs:552`）应改为 `&Path`；
- 其余 4 条为风格类告警：`agent_files.rs:274` 冗余 `as_bytes`、`pi_rpc.rs:50` 空切片比较、`skill_market.rs:195` 与 `main.rs:477` 长度比较。

## 5. 改进优先级建议

> 更新于 2026-08-08：P0-P2 全部完成，P3 中 L1、L4 与 clippy 清理完成。

### P0（安全，建议尽快）

1. 为全部非 `/internal/*` 的状态接口增加令牌认证，并停止对 `Origin: null` 回显 CORS（H1）。
2. 内部令牌比较改为恒定时间（H2）。

### P1（正确性）

3. 修复 `memory.stats` 截断统计（M1）。
4. 拆分 `schemaRevision` / `schemaRevisionId` 语义并去掉跨 schema 的 id 回退（M2）。

### P2（健壮性）

5. Bridge 请求加超时与 pending 清理（R1）。
6. 连接读取超时 + 并发上限（R2）。
7. Agent SSE 断连时主动停止 worker（R3）。

### P3（清理）

8. 删除 `parts[0] == *id` 冗余条件（L1）。
9. 处理 `MemoryError` 大变体装箱，消除 clippy `result_large_err`。
10. 明确远端/本地安装一致性回滚策略（L4）。

## 6. 附带说明

- 本报告只做审查与记录，未修改任何代码；如需按 P0-P3 实施修复，可基于本报告拆分任务。
- 审查期间工作区存在未提交改动（Electron 侧功能模块/Agent 相关），均不在本次 Rust 审查范围内。
- 服务只监听 `127.0.0.1:51730`（`COPIS_HTTP_API_PORT` 可覆盖），绑定面正确；`resolve_memory_directory`/`resolve_expert_teams_directory` 优先读取 `COPIS_*` 环境变量，其次 `~/.copis/`，与 Electron 侧路径契约一致。

## 7. 修复记录（2026-08-08）

### 7.1 已完成

| 编号 | 修复内容 | 验证 |
|------|----------|------|
| H1 | Web 令牌认证 + CORS 令牌接入（Rust gate + Electron 注入与客户端接入） | `cargo test` 新增 3 用例；Electron 8 个测试文件通过 |
| H2 | 内部/Web 令牌恒定时间比较 | 新增单测，`cargo test` 通过 |
| M1 | `memory.stats` SQL 聚合统计全部条目 | 新增 51+ 条统计单测 |
| M2 | `schemaRevisionId` / `schemaRevision` 语义拆分，去除跨 schema id 回退 | 新增 3 个单测 |
| R1 | Bridge `recv_timeout` + pending 清理 + 504 超时响应 | 新增超时单测 |
| R2 | 连接读超时 + 最大并发连接数（64） | 新增真实 TCP 超时单测 |
| R3 | SSE 写失败/读失败主动停止 worker | `cargo test` 通过 |
| L1 | 删除 `parts[0] == *id` 冗余条件（4 处） | `cargo test` 通过 |
| L4 | 本地安装失败时回滚远端安装状态（无其他工作区使用且安装前本地不存在时 DELETE 远端；无法判断时保守不回滚） | 新增 2 个单测（回滚/不回滚），`cargo test` 通过 |
| Clippy | `MemoryError` 大变体装箱（`Conflict(Box<MemoryEntry>)`、`MaintenanceConflict(Box<...>)`）；`ptr_arg`×2（`&Path`）；`needless_as_bytes`、`comparison_to_empty`、`len_zero`×2、`needless_borrows`×2 | `cargo clippy --all-targets -- -D warnings` 0 告警 |

### 7.2 测试环境修复

- `http-api-server-runtime.test.ts` 的 electron mock 缺少 `WebContentsView`，单独运行该文件时导入失败（预存问题，与本次改动无关）；已补齐 `WebContentsView: class {}`。该文件 10 个用例现可单独运行并通过。
- 注意：含 electron mock 的测试文件需分进程运行，避免 mock 互相覆盖产生假失败（与 AGENTS.md 中网页测试的约束一致）。

### 7.3 暂缓/未处理（需用户确认）

- **L4**（`skill_market.rs` 远端已装/本地安装失败不回滚）：已于 2026-08-08 修复并测试，见 7.1。
- **R4**（Bridge `available` 置 false 后不恢复）：写失败即桥损坏属于当前契约，保留现状；如需支持瞬时背压恢复需确认 Electron 侧行为。
- **L2/L3/L5/L6/L7/L8**：属于低风险优化或文档声明项，未在本次范围内改动。

### 7.4 最终验证命令（2026-08-08）

```bash
cd native/http-api-server
cargo test --locked               # 87 passed; 0 failed
cargo clippy --all-targets -- -D warnings   # 0 告警
cd ../..
bun run --filter='@copis/electron' typecheck # 通过
# 相关 Electron 测试（逐个进程运行）：
bun test apps/electron/src/main/lib/http-api-server.test.ts
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
bun test apps/electron/src/renderer/lib/agent-http-stream.test.ts
bun test apps/electron/src/renderer/lib/file-api-client.test.ts
bun test apps/electron/src/renderer/lib/expert-team-api.test.ts
bun test apps/electron/src/renderer/lib/working-skill-market-api.test.ts
bun test apps/electron/src/renderer/lib/http-api-bridge.test.ts
bun test apps/electron/src/main/lib/working-api-client.test.ts
```

### 7.5 测试代码拆分（2026-08-08）

- 将 7 个源文件末尾的 `#[cfg(test)] mod tests { ... }` 全部拆出，各自移到同目录独立文件，并在原文件声明处改为：
  ```rust
  #[cfg(test)]
  #[path = "memory_tests.rs"]
  mod tests;
  ```
- 拆分方式保持模块语义完全不变（`#[path]` 子模块仍属于原父模块，`super::*` 引用不受影响），生产代码行号未变。
- 效果：生产代码由 10,970 行（含测试）降为 8,637 行；7 个 `*_tests.rs` 共 2,333 行测试代码不再占用生产文件。
- 验证：`cargo build --locked`、`cargo test --locked`（87 passed / 0 failed）、`cargo clippy --all-targets -- -D warnings`（0 告警）均通过。
