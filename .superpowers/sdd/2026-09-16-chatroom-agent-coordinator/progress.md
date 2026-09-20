# SDD ledger — plan: docs/superpowers/plans/2026-09-16-chatroom-agent-coordinator.md

Spec: `docs/superpowers/specs/2026-09-16-copis-multi-agent-chatrooms-design.md`
Phase 2 accepted head: `da3ab2bd`

## Preflight

- Phase 3 只实现 Electron Main 本地 Agent 协调器及必要 Shared/IPC/Preload 接缝；Renderer 页面与 COS SDK 属于 Phase 4。
- Rust internal bridge 路由已经 Phase 2 验收；Electron Main 不持有 Working JWT，也不直连 edu-api。
- 所有任务执行 BDD/TDD，记录 RED/GREEN；每项完成后由 controller 独立验证并派发 fresh Luna reviewer。
- 保留 worktree 中 5 个既有 Rust dirty 文件，不清理、不回滚、不纳入提交。
- 不修改 `AGENTS.md`、`README.md`，不 push/merge/deploy/publish。
- Ruling: 原 ledger 误建在 `.superpowers/sdd/2026-09-18-chatroom-agent-coordinator/progress.md`；从本行起以 `sdd-workspace`/`task-brief` 根据 plan basename 解析出的 `2026-09-16-chatroom-agent-coordinator/` 为唯一活动 workspace，旧文件仅保留为历史证据。若此裁定错误，代价是需要合并两个 scratch ledger，但不影响代码或提交历史。

### Remaining-task interface scan

| Tasks | Producer -> consumer | Check |
|---|---|---|
| 2 -> 3/4/5/6 | 路径 helper -> room store、隐藏 session、runtime scope、Skill snapshot | 签名与 File Map 一致；后续不得自行改名。 |
| 1 -> 3/5/7/8/9/10 | Shared DTO/validator/constants -> Main store、runtime、Rust client、sanitizer、coordinator、IPC | 一致；Main-only runtime context 不得进入 IPC DTO。 |
| 3 -> 6/9/10 | `ChatRoomWorkspaceStore` -> snapshot digest、coordinator、IPC list/config | 一致；Task 6 只扩展 snapshot 更新，不改变持久化权威边界。 |
| 4 -> 5/9 | hidden session override -> trusted execution/coordinator registration | 一致；普通 session index/list 仍不感知聊天室 session。 |
| 5 -> 8/9 | trusted runtime context -> prompt/sanitizer/coordinator | 一致；Renderer/public HTTP 不能伪造 runtime override。 |
| 7 -> 9/10 | Rust internal client/bridge callbacks -> coordinator dispatch and lifecycle wiring | 一致；Electron Main 不持有 Working JWT。 |
| 8 -> 9 | structured output sanitizer -> next-hop creation | 一致；纯文本 `@名称` 永不触发 Agent。 |
| 9 -> 10 | coordinator API/events -> IPC、Preload、main lifecycle | 一致；disconnect/app quit 立即停止，不排队重放。 |
| 3 | 测试、schema、compaction、文件列表内部一致性 | 一致；terminal 为 completed/failed/rejected，active 不裁剪。 |
| 4 | override 路由列表与测试内部一致性 | 一致；只路由指定 session 读写 API。 |
| 5 | trust-boundary 测试与 runtime scope 规则内部一致性 | 一致；Memory `visible/off` 与 Skill snapshot 独立。 |
| 6 | snapshot 原子替换、digest、只读权限与 rollback 内部一致性 | 一致。 |
| 7 | 五个 Rust API 方法、bridge 路径与测试内部一致性 | 一致。 |
| 8 | 完整 JSON 对象解析、fallback 和 allowlist 内部一致性 | 一致。 |
| 9 | depth 0/1/2、下一跳 3 拒绝、trace 幂等、权限 timeout 内部一致性 | 一致。 |
| 10 | Shared/IPC/Preload/Main 四层接缝与生命周期测试内部一致性 | 一致。 |

- Ruling: 以计划正文的十个 heading 为权威任务映射：Task 7 = Rust Internal Client and Bridge Dispatch，Task 8 = Structured Output Parsing and Sanitization，Task 9 = ChatRoomAgentCoordinator，Task 10 = Shared Electron API/IPC/Preload/Lifecycle。若此裁定错误，代价是 review package/ledger 标签需重命名，但实现依赖顺序不变。
- Ruling: Task 3 必须复用 `readJsonFileSafe()` 的 `.tmp/.bak` 恢复语义，但不能让该 helper 的既有绝对路径日志进入聊天室链路；允许 Task 3 以向后兼容的可选脱敏日志标签扩展 `safe-file.ts` 并增加聚焦测试，聊天室 store 传固定中文标签，现有调用保持默认行为。若此裁定错误，代价是多一个共享 helper 的兼容参数和测试面；不这样处理则会直接违反规格的日志敏感信息约束。

## Tasks

- Task 1 — Shared Chatroom Contracts: complete at `68e41015`. Controller verified focused 11/11, shared 71/71, shared typecheck and diff checks. Fresh Luna re-review: APPROVED, no Critical/Important; strict own-property/prototype/symbol/sparse-array/optional-field boundaries closed. Ruling: `ChatRoomAgentRuntimeContext` remains a shared compile-time contract because the plan explicitly defines it as a Cross-Task Interface; values remain Main-only and no IPC DTO contains that field.
- Task 2 — Stable Client Device ID and Chatroom Paths: fix round 4/5 completed at `ffb00249`. Controller verified client-device 18/18, WebSync 8/8, Electron typecheck, main/renderer builds and diff checks. Fresh Luna re-review: APPROVED; Windows read path now uses lstat/realpath/fd/path identity checks to fail closed, and legacy `.lock/owner.json` directories distinguish active/dead/ownerless owners with inode/owner revalidation and non-recursive cleanup.
- Task 2: minor (deferred): malformed legacy lock directories with extra files or non-regular `owner.json` can leave a unique `.reclaim-*` residue after failing closed; canonical lock is released, so this does not block progress.
- Task 2: residual verification: Windows reparse-point behavior is statically reviewed and type/build checked but still requires a real Windows runner or actual Windows application verification.
- Task 2: complete (commits `68e41015..ffb00249`, review clean)
- Task 3 — Workspace Store: initial commit `a896278f`; controller verified store 10/10, client-device 18/18, Electron typecheck, main build and diff checks. Fresh Luna review: CHANGES REQUESTED — Critical pre-validation path traversal plus Important persisted version, corrupt-vs-missing, directory transaction/validation, pre-write path validation, invocation state matrix, trace+agent idempotency, and archived-agent capacity/name semantics findings. Fix round 1/5 dispatched to the original implementer.
- Task 3: Ruling: `archiveAgent()` 表示逻辑移除；归档 Agent 保留本地目录和历史配置，但不占最多 3 个活跃 Agent 名额，且其 display name 可由新的活跃 Agent 复用。若此裁定错误，代价是可能允许房间累计超过 3 份归档目录；不过远端/运行时仍最多 3 个活跃 Agent，符合用户可移除并替换 Agent 的产品语义。
- Task 3: minor (deferred): `.bak` 恢复未把 room.json 的 `0o600` mode 传回原子写入 helper。
- Task 3: minor (deferred): 部分 filesystem error `cause` 可能携带绝对路径；最终 review 必须按聊天室日志/错误脱敏约束复核。
- Task 3: fix round 1/5 (8 addressed, 2 open — `updateAgent()` 仍与 archived displayName 冲突；持久化 `roomAgentId` 未按 path component 严格校验，read 可越出 agents 根；commit `bc78a021`)
- Task 3: fix round 2/5 (2 addressed, 0 open — archived displayName update 和 persisted roomAgentId path-component 校验；commit `76c7b627`)
- Task 3: complete (commits `ffb00249..76c7b627`, review clean). Controller verified store 21/21, client-device 18/18, Electron typecheck, main build and diff checks; fresh scoped re-review APPROVED.
- Task 4 — Hidden Session Storage: in progress from base `76c7b627`. Carry-forward constraint: `sessionId` remains a bounded identifier and override-map key; the hidden files use the fixed roomAgent `sessions/` directory and must not derive a filesystem component from `sessionId`.
- Task 4: Ruling: brief prose says hidden meta is `session.json`, but Task 2's produced cross-task path helper is `getChatRoomAgentSessionMetaPath()` and resolves to `sessions/meta.json`; Task 4 must consume that helper rather than inventing a second filename. If this ruling is wrong, the cost is a local filename migration before release; no public DTO or remote contract depends on the filename.
- Task 4: initial commit `beb008a5`; controller verified hidden 7/7, manager 24/24, workspace 21/21, Electron typecheck, main build and diff checks. Fresh Luna review CHANGES REQUESTED — hidden meta accepts unknown/immutable/config-mismatched fields; JSONL accepts syntactically valid non-message shapes. Fix round 1/5 dispatched.
- Task 4: fix round 1/5 at `479a6064` closed strict meta/schema findings, but fresh re-review found two compatibility regressions: mixed SDK records were rejected by `getAgentMessages()`, and a fixed SDK type allowlist rejected shared-contract extension events.
- Task 4: fix round 2/5 at `4dd11922` restored mixed legacy/SDK JSONL compatibility and extensible SDK types while retaining fail-closed shape checks. Fresh re-review found one remaining extension-compatibility issue: global `error.message` validation was applied to unknown event types.
- Task 4: fix round 3/5 at `c9ed3a10` scopes strict `error.message` validation to known assistant events and leaves unknown extension fields forward-compatible. Controller verified hidden 13/13, manager 24/24, workspace 21/21, Electron typecheck, main build and diff checks. Fresh scoped re-review: APPROVED, no Critical/Important.
- Task 4: complete (commits `76c7b627..c9ed3a10`, review clean).
- Task 5 — Trusted Agent Runtime Context: initial commit `b3160244`; controller verified runtime 2/2, RPC 32/32, source lifecycle 3/3, Electron typecheck and main/renderer builds. Fresh Luna review CHANGES REQUESTED — legacy business-tool leakage, inherited bypass/advanced authorization, trusted source leak on failed context registration, workspace/Memory slug coupling and registry hardening gaps.
- Task 5: fix round 1/5 at `1000218a` introduced an explicit chatroom capability profile, transactional registry cleanup, strict plain-data context validation, Memory/runtime scope split and hidden Pi artifact directories. Fresh re-review found project extension auto-discovery, insecure legacy local tools, ordinary history/session-cleaner coupling and unaudited RPC Shell paths.
- Task 5: fix round 2/5 at `db4dfb1f` set `noExtensions`, removed Bash pending host approval, made legacy no-policy file tools fail closed, disabled ordinary history guides and rejected public internal capability fields. Fresh re-review found one final fail-open: missing chatroom `memoryPolicy` defaulted to writable in the lowest RPC tool builder.
- Task 5: fix round 3/5 at `ba73cc25` makes both final tool builders accept only explicit `visible` for chatroom Memory; undefined/off/writable all resolve to off while ordinary sessions retain undefined→writable compatibility. Controller verified builtin tools 22/22, RPC 34/34, runtime 5/5, protocol 14/14, typecheck, main build and diff checks. Fresh scoped re-review: APPROVED, no Critical/Important.
- Task 5: Ruling: Chatroom Bash remains absent until Task 9 has a host-only approval path; project-local Read/Edit/Write continue through the Rust file policy. This is a fail-closed interim boundary, not a product decision to permanently remove Shell.
- Task 5: complete (commits `c9ed3a10..ba73cc25`, review clean).
- Task 6 — Skill Snapshot: initial commit `2ee3863a`; nine scoped fix rounds closed crash recovery, parent-chain/TOCTOU, cross-process locking, durable fsync, Windows ACL command construction, fixed `.tmp/.bak` clobbering, source side effects, bounded owner-bound A/B recovery, legacy-slot compatibility and raw payload-size enforcement. Accepted head: `e387e536`.
- Task 6: controller verified snapshot 32/32 plus 10 independent repeat runs, workspace 22/22, safe-file 25/25, durable-fs 3/3, runtime context 5/5, RPC 34/34, shared chatroom 11/11, Electron typecheck, main/renderer builds and diff checks. Fresh Luna re-review of `cc9757c1..e387e536`: APPROVED, no Critical/Important.
- Task 6: accepted invariants include enabled-only read-only snapshot copies, deterministic digest, atomic journal recovery, source/target symlink and hardlink rejection, owner-token-bound recovery slots, fixed external `.bak` preservation, 2 MiB room-config boundary without changing generic JSON compatibility, and legacy recovery only when the stable owner token matches.
- Task 6: residual verification: real Windows ACL/reparse/directory-flush/rename behavior still requires a Windows runner; pure Node cannot fully eliminate same-UID nanosecond ABA races, and SIGKILL/power loss can leave unique temporary files for later manual cleanup. These are recorded non-blocking platform residuals.
- Task 6: complete (commits `ba73cc25..e387e536`, review clean).
- Task 7 — Rust Internal Client and Bridge Dispatch: initial commit `874aeff1`; three scoped Electron/Rust-contract fix rounds at `7be29d9d`, `fcdaf5f6`, and `12105a57` closed exact request bodies, Main-only context, static coordinator loading, strict callback states, bounded/redacted errors, runtime output validation, control-character handling, and field-specific 64/128-byte protocol limits.
- Task 7: fix round 4/5 used a fresh implementer after the original three rounds. Copis `54013ab9` plus ai-education companion `c3a5bef0` introduced the real full invocation DTO from edu-api through Rust to Electron, shared HTTP/WS payload building, oldest-first context bounded to 200 messages and 120 KiB, 128 KiB Rust bridge validation, agent-next-hop and soft-deleted historical sender support, and rejection of legacy/minimal/status-bearing payloads. Controller verified edu-api service/handler ChatRoomV2 suites, Rust gateway 55/55, Rust protocol 28/28, Electron client 17/17, handler 16/16, coordinator scaffold 2/2, shared 11/11, typecheck, main/renderer builds, gofmt/cargo fmt and diff checks.
- Task 7: fix round 4/5 review left 2 Important open — Agent `displayName` is accepted by Shared/edu-api with boundaries that the builder/Rust later reject, and builder failure can silently leave invocation in `created`; Electron Shared validator also accepts empty/unrelated message context that Rust rejects. Minor deferred: `chatroom_v2_wire.go` still describes the frame limit as 64 KiB although the implemented limit is 128 KiB. Fix round 5/5 dispatched to a fresh Luna implementer.
- Task 7: fix round 5/5 at Copis `b3eb4fcc` plus ai-education `085bb210` addressed strict nonempty/trigger/sender invocation validation and the 128 KiB text, but breaker re-review left 3 Important open: FEFF trim canonicalization still differs across JS/Go/Rust; delivery failure has no atomic newly-transitioned signal and can republish the wrong failure code; builder failure publishes `agent.failed` only to the owner device instead of the room.
- Task 7: parked (load-bearing, carry into Task 8) — cross-language displayName canonicalization. Ruling: all three runtimes must trim the same explicit edge set (`Unicode White_Space` plus U+FEFF), reject Unicode Cc controls, persist the canonical value, and enforce UTF-8 <=128 bytes. If wrong, the cost is a pre-release name migration or a narrower accepted character set; leaving it divergent causes real cross-client conflicts.
- Task 7: parked (load-bearing, carry into Task 8) — invocation builder-failure idempotency. Ruling: add an atomic server transition API that reports whether `created|accepted|running -> failed(invalid_invocation)` happened; publish only on a new transition and never overwrite or misreport an existing terminal code. If wrong, the cost is one extra internal service method; without it duplicate delivery can contradict persisted state.
- Task 7: parked (load-bearing, carry into Task 8) — builder-failure visibility. Ruling: a newly persisted `agent.failed` must use the same room-wide transient broadcast semantics as the existing terminal failure path, with a two-member regression test; `agent.invocation` alone remains owner-device-targeted. If wrong, the cost is exposing a stable failure status to all active room members, which matches the existing event model and contains no private payload.
- Task 7: complete at Copis `b3eb4fcc` with ai-education companion `085bb210` (breaker reached; 3 load-bearing findings explicitly carried into Task 8). Controller verified Shared 73/73, workspace 22/22, handler 17/17, full Rust 443/443, Go services/handlers, Electron typecheck, main/renderer builds, gofmt/cargo fmt and diff checks.
- Task 8 — Structured Output Parsing and Sanitization: pending
- Task 9 — ChatRoomAgentCoordinator: pending
- Task 10 — Shared Electron API, IPC/Preload Bridge and Lifecycle Cleanup: pending
