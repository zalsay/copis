# 超 600 行代码文件重新扫描与拆分计划

> 状态：仅更新清单与计划，未实施代码拆分。
> 扫描日期：2026-09-10；基准 HEAD：`03679b6b`，统计包含扫描时工作区未提交改动。
> 当前清单：[files-over-600-lines.md](files-over-600-lines.md)。旧 [Top 5 设计](large-file-split-plan.md) 保留作历史参考，其中行号、注册器签名和目标布局需以本文及当前源码为准。
> 目标：按现有职责将手写生产源码控制到每文件 ≤600 行，保留行为、协议和存储兼容。
> 技术栈：Bun、TypeScript、Electron、React/Jotai、Rust。执行时按项目开发流程逐批验证；本次不创建提交、不发布、不改应用版本。

## 扫描口径与总览

使用 `rg --files --hidden` 枚举非忽略文件，扩展名为 ts/tsx/rs/js/jsx/vue；排除 .git、node_modules、dist、out、third_party、default-skills、target、resources、vendor、coverage、build 目录。按 LF 数计行，与 `wc -l` 一致；阈值为严格大于 600。不是整个磁盘扫描，忽略目录内的模板/第三方代码不纳入。

测试识别包括 `.test.*`、`.spec.*`、`*_test.rs`、`*_tests.rs`、`tests/`、`*_test_backend.rs` 和已核实的 `apps/electron/scripts/browser-workflow-e2e-main.ts`。测试和 E2E 单列，不能混入生产数量。

| 分层（互斥） | 生产文件 | 测试/E2E |
|---|---:|---:|
| Electron 主进程（含 IPC） | 35 | 10 |
| Rust HTTP API | 15 | 6 |
| Electron 渲染进程（含 hooks/atoms/入口） | 29 | 2 |
| Preload | 2 | 0 |
| 共享包 | 2 | 0 |
| 根脚本 | 2 | 0 |
| 应用测试脚本 | 0 | 1 |
| **合计** | **85** | **19** |

旧日期的行数变化属于正常快照差异；本次补齐当前范围，而不把增量推断成旧扫描当时的遗漏。

## 通用约束

1. 保留旧导入入口与导出签名；内部依赖允许随迁移调整。IPC 通道、参数顺序、响应和取消订阅协议保持不变。默认不引入注册框架、状态容器或新依赖。
2. 保持现有 Jotai atom 身份、进程单例和生命周期，不复制状态。保持 JSON/JSONL 与现有数据库布局，不借拆分更换存储。
3. 每一小批先建立可通过的现状行为基线，再移动一个职责、验证；新增边界测试写 Given/When/Then。纯重构不人为要求现状行为测试先失败。
4. AGENTS.md 规定提交代码时递增受影响包 patch；不是每移动一个文件就改版本。此次仅文档更新且不提交，不调整包版本。平台发布版本另遵守平台映射规则。
5. Rust 规范写的是同目录 `*_test.rs`，现存多为 `*_tests.rs`；已有命名先保留，新测试按规范，更新实际 `#[path]`/mod 声明。不将测试内嵌回生产文件；测试单列不代表获准超过 600 行。
6. 新文件建议 150–450 行、硬上限 600；不是靠删注释或把 1000 行原样搬到另一个文件完成。大型目录可分批迁移，只有旧门面和全部新增手写文件均达标才勾选完成。
7. Electron UI 的真实交互与视觉仍由用户在实际窗口验收，不使用截图代替。AGENTS.md/README.md 若因后续功能变化需同步，按仓库规则取得允许；此次不改这两份文件。

## 一、前 5 大文件（当前基线，执行步骤见第八节）

| 文件 | 行数 | 方案 |
|------|-----:|------|
| `apps/electron/src/main/ipc.ts` | 5459 | → 方案 1：按业务域拆 `main/ipc/*.ipc.ts` 注册器 |
| `native/http-api-server/src/main.rs` | 3847 | → 方案 2：拆 `http/` + `router.rs` + `routes/*` |
| `AgentConversationSurface.tsx` | 3212 | → 方案 3：交互逻辑抽 `conversation/use*.ts` hooks |
| `agent-orchestrator.ts` | 2862 | → 方案 4：`sendMessage` 分解到 `orchestrator/` 协作单元 |
| `preload/index.ts` | 2922 | → 方案 5：按域组合 `api/*.ts` 分片 |

---

## 二、Electron 主进程（`apps/electron/src/main`）

### 大型集成桥接（>900 行）

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `lib/feishu-bridge.ts` | 2593 | 拆 `feishu/bindings.ts`、`session-mirror.ts`、`commands.ts`、`message-dispatch.ts`、`stream-reply.ts`、`chat-context.ts`；本文件保留类门面和运行状态所有权。保留飞书卡片、合批及终态去重，不强行并入通用 Bridge handler；不新增此文件未承载的 crypto/注册逻辑。 |
| `lib/adapters/pi-agent-adapter.ts` | 2160 | 拆 `adapters/pi/session-lifecycle.ts`、`tool-bridging.ts`、`model-builder.ts`；保留 PiAgentAdapter 门面与运行状态。已有 pi-default-extensions.ts 继续复用，不为目录整齐另搬一遍。验证恢复/中断、工具权限及扩展加载路径。 |
| `lib/wechat-bridge.ts` | 973 | 拆 `wechat/`：`ilink-login.ts`（扫码登录）、`long-connection.ts`（长连接监听与重连）、`message-dispatch.ts`；配置读写已在 `wechat-config.ts` 不动 |
| `lib/bridge-command-handler.ts` | 916 | 保留现有 `BridgePlatformAdapter`；按命令行为拆 `bridge-commands/session-commands.ts`、`model-commands.ts`、`message-dispatch.ts`，共享绑定上下文。飞书目前独立使用卡片链路，本次不强行接入；不按平台复制通用命令。 |

### Agent 核心链路

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `lib/agent-workspace-manager.ts` | 2111 | 拆 `workspace/`：`workspace-crud.ts`、`mcp-config.ts`（MCP JSON 读写）、`skills-config.ts`、`skills-upgrade.ts`（`upgradeDefaultSkillsInWorkspaces` semver 同步，独立可测）；manager 保留编排门面 |
| `lib/channel-manager.ts` | 1985 | 拆 `channel/crypto.ts`、`store.ts`、`connectivity.ts`、`models.ts`，旧入口保留导出；加密依赖 safeStorage 属于外部边界，不视为纯函数。保持密文兼容、失败不覆盖旧配置、模型解析语义。 |
| `lib/agent-session-manager.ts` | 1658 | 拆：`session-jsonl-store.ts`（JSONL 追加/读取，纯 IO 可测）、`session-meta-store.ts`（索引 CRUD + 置顶）、`bridge-sessions.ts`（飞书/微信/钉钉专属会话与模型继承） |
| `lib/http-api-handler.ts` | 1410 | 与 Rust 侧方案对齐：按 `/api/*` 前缀拆 handler 模块（memory/workspace-dev/automation/expert-team/internal-bridge），公共 token 校验与响应封装抽 `http-common.ts` |
| `lib/browser-workflow-service.ts` | 1530 | 拆：`recording-state-machine.ts`（状态迁移，纯逻辑补测）、`draft-validator.ts`（Draft 重校验）、`jsonl-sanitizer.ts`（脱敏序列化）；service 保留 IPC 编排 |
| `lib/agent-rpc-service.ts` | 959 | 按消息方向拆：`rpc-request-mapper.ts`、`rpc-event-mapper.ts`（映射纯函数补测），service 缩为 stdio 会话管理 |

### 工具与运行时支撑

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `lib/adapters/pi-builtin-tools.ts` | 1066 | 每组内置工具一个文件：`tools/file-tools.ts`、`tools/browser-tools.ts`、`tools/memory-tools.ts` 等，注册表聚合；工具 schema 与执行分离 |
| `lib/agent-collaboration-tools.ts` | 1086 | 按协作能力拆：子智能体派发 / Browser Workflow 总结 / 任务交接三块，各自独立导出工具定义 |
| `lib/web-tab-manager.ts` | 1542 | 拆 `web-tabs/bookmarks-window.ts`、`cdp-bridge.ts`（对接已有 cdp-session-router）、`contents-events.ts`、`session-persist.ts`；门面持有唯一 tab record 集合与 host window，子模块通过显式参数访问。保持 workflow tab、无痕 partition、密码提示、JS 对话框和销毁竞态语义。 |
| `lib/migration-service.ts` | 1266 | 改为版本化迁移注册表：`migrations/v{N}.ts` 每版本一文件 + runner 循环执行；每个迁移步骤可独立测试 |
| `lib/working-api-client.ts` | 920 | 按端点域拆 `working-api/`：`auth.endpoints.ts`、`orders.endpoints.ts`、`payment.endpoints.ts`、`model-catalog.endpoints.ts`，共享 fetch 封装留 client 本体 |
| `lib/config-paths.ts` | 915 | 「路径解析」与「seed/upgrade 副作用」（`seedDefaultSkills` 等）分离为 `config-paths.ts`（纯函数）+ `default-skills-seeder.ts`（IO 副作用），便于测试 mock |
| `lib/http-api-server.ts` | 903 | 拆：`http-api-process.ts`（子进程 spawn/退出处理）、`http-api-env.ts`(env 注入组装，纯函数)、health/ready 探测独立 |
| `lib/adapters/pi-model-registry.ts` | 760 | 模型目录数据（静态表）与解析逻辑分离：`pi-models.data.ts` 常量表 + `pi-model-registry.ts` 查询函数 |
| `index.ts`（入口） | 771 | 拆 `app/window-factory.ts`、`app/lifecycle-hooks.ts` 与单实例处理；入口保留启动次序，避免 app.ready 前执行原生窗口操作。 |
| `lib/git-diff-service.ts` | 741 | git 命令封装（exec 辅助）与 diff 解析/格式化分离，解析纯函数补测 |
| `lib/file-preview-service.ts` | 820 | 按预览类型拆 provider（图片/PDF/文本/Office），注册表分发 |
| `lib/browser-page-control-service.ts` | 841 | 操作校验（nonce/Origin/isTrusted）抽 `page-action-guard.ts` 纯函数层，service 缩为执行层 |
| `lib/storage-service.ts` | 637 | 统计计算（纯遍历汇总）与清理执行（删除副作用）分离 |
| `lib/browser-agent-tool-service.ts` | 630 | 工具参数校验与 capability 判定抽纯函数模块（对应已有测试直接迁移） |
| `lib/planning-manager.ts` | 624 | 计划 CRUD 存储与冲突检测（`PLANNING_CONFLICT_ERROR` 相关纯逻辑）分离 |
| `lib/browser-workflow-playwright-script.ts` | 610 | 在源码侧新建 `browser-workflow-script/template.ts`（生成脚本的模板）与 `compiler.ts`（版本编译），本文件保留路径、原子写入、SHA256 与完整性检查；模板继续随构建内联，不直接迁往 resources。生成文本须逐字一致，避免已发布脚本哈希失效。 |

---

## 三、渲染进程（`apps/electron/src/renderer`）

### atoms / 入口

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `atoms/agent-atoms.ts` | 1316 | 拆 `atoms/agent/sessions.ts`、`stream-state.ts`、`permissions.ts`、`workspaces.ts`，原 `agent-atoms.ts` 保留 re-export。先画依赖方向，基础 atom 只创建一次；写 atom 通过 get/set 访问已有 atom，不让分片互相循环 import。 |
| `main.tsx` | 1261 | 把顶层已有 Initializer 的实现逐个迁入 `bootstrap/initializers/`，再抽 Provider 装配；保留独立窗口入口分发和初始化顺序，全局监听仍只挂载一次。不能只抽 Provider/错误边界就宣称达到行数目标。 |

### 组件（按职责拆分，不仅按 JSX 长度）

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `components/agent/SDKMessageRenderer.tsx` | 1493 | 按现有职责抽 `sdk-renderers/AssistantTurnRenderer.tsx`、`UserMessageRenderer.tsx`、`SystemMessageRenderer.tsx` 和动作栏；继续复用 `ContentBlock`、`ProcessBlockGroup`。Turn 分组及信封处理已来自 `@copis/session-core`，保留 re-export，不重复实现。 |
| `components/diff/DiffTabContent.tsx` | 1474 | 拆 `diff/tab/`：`DiffToolbar.tsx`、`DiffFileList.tsx`、`DiffHunkView.tsx` + `useDiffData.ts` hook；与已有 `DiffChangesList.tsx` 复用合并 |
| `components/agent/SidePanel.tsx` | 1363 | 按 section 拆子组件（会话列表/项目列表/队列消息/后台任务），每个 section 一个文件 + 数据 hook |
| `components/ai-elements/rich-text-input.tsx` | 1254 | 拆：TipTap extension 配置 → `rich-text/extensions.ts`、菜单/工具条 → `rich-text/EditorToolbar.tsx`、历史导航（已有 `composer-history` atom）相关 handler → hook；已有 contract test 作回归基线 |
| `components/diff/markdown-preview-extensions.tsx` | 1189 | 按 TipTap/ProseMirror 扩展拆 `markdown-extensions/code-block.tsx`、`image.ts`、`table.ts`、`math.ts`、`task-list.ts`；保留 PluginKey、缓存、NodeView destroy 与 React root.unmount 的归属及扩展顺序。这是编辑器扩展，不是普通 Markdown 插件数组。 |
| `components/automation/AutomationFormView.tsx` | 1122 | 表单字段区块拆子组件 + `useAutomationForm.ts`（校验/提交纯逻辑外移补测） |
| `components/file-browser/FileBrowser.tsx` | 1014 | 文件树节点渲染、面包屑、预览面板拆子组件；树构建纯函数外移（配合已有 FileDropZone） |
| `components/web-browser/WebBrowserSurface.tsx` | 1005 | 工具栏/页签条/侧栏恢复逻辑拆子组件与 hooks；遵守 AGENTS.md 原生页签约束章节 |
| `components/ai-elements/message.tsx` | 829 | 按 role/content 形态拆分支渲染子组件 |
| `components/agent/AgentMessages.tsx` | 811 | 自动滚动/虚拟化逻辑抽 `useMessageListScroll.ts`；单条消息项已是子组件则继续细分 |
| `components/app-shell/CopisWorkingMessageSettingsPanel.tsx` | 1231 | 设置分区各成一个 section 组件（已有 working-settings-menu-contract.test 作基线） |
| `components/app-shell/CopisWorkingSidebar.tsx` | 1184 | 导航区/账户区/订单入口拆子组件 |
| `components/ui/image-editor.tsx` | 716 | canvas 绘制操作抽 `image-editor/canvas-ops.ts` 纯函数（坐标变换/裁剪计算可测），React 层只留交互 |
| `components/memory/MemoryImportView.tsx` | 745 | 解析预览卡片、结果统计卡拆子组件；`memory-import-parser.ts` 已独立，视图只做展示 |
| `components/app-shell/CopisWorkingPaymentModal.tsx` | 701 | 二维码展示/订单状态轮询（hook）/套餐选择拆分 |
| `components/voice-dictation/VoiceDictationApp.tsx` | 676 | 抽 `useVoiceAudioCapture.ts`（现有 Web Audio/ScriptProcessor PCM 采集与清理）、`useVoiceDictationSession.ts`（IPC、ASR 就绪队列、停止与提交竞态）、展示子组件。保持音频格式，不改成 MediaRecorder。 |
| `components/agent/ContentBlock.tsx` | 693 | 按 block type 分支拆小渲染器，与 ContentBlock 注册表并列 |
| `components/web-browser/WebBookmarksPopover.tsx` | 711 | 树形 UI 节点组件与展开状态管理（渲染进程态）拆分；持久化模型（groupId）不动，遵守浮层窗口全部实现约束 |
| `components/expert-team/ExpertTeamView.tsx` | 672 | 团队列表/成员详情/运行状态拆子组件 |
| `components/app-shell/CopisWorkingSettingsPanel.tsx` | 717 | 同 CopisWorking 系列：section 化 |
| `components/agent/AskUserBanner.tsx` | 639 | 选项渲染/表单型问答/超时逻辑拆分，选项归一化纯函数补测 |
| `components/app-shell/SearchDialog.tsx` | 603 | 抽 `useSessionSearch.ts`（查询、防抖、searchToken 防止旧结果覆盖）、`SearchResultList.tsx` 与高亮文本组件；保留现有 IPC 搜索服务，不在 UI 新建搜索打分算法。 |

---

## 四、Rust HTTP API（`native/http-api-server/src`）

除 `main.rs` 外逐域拆分，按各文件真实职责选择存储、协议或进程边界，不强行给所有模块套三层结构：

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `memory.rs` | 2220 | 拆 `memory/types.rs`、`schema.rs`、`entry_store.rs`、`revision_store.rs`、`maintenance_state.rs`。SQL 事务仍由同一连接持有者控制，revision 检查和写入不能分事务。HTTP 路由主要在 main.rs，随入口批次迁移；不把 Pi 侧记忆提炼策略重做进 Rust。 |
| `expert_teams.rs` | 1462 | 拆 `expert_teams/schema_store.rs`（schema/revision）、`run_store.rs`（运行记录）、`validation.rs`（DAG/路径校验）、`http.rs`（请求分发）；复用现有执行入口，不将运行记录 CRUD 误当新团队执行引擎。 |
| `skill_market.rs` | 1456 | 按商品查询、购买流程和上游客户端适配拆 `skill_market/catalog.rs`、`purchase.rs`、`client.rs`；保留现有 trait 和错误响应，不把 main.rs 中 parse_auth_working_response 误列为本文件函数。 |
| `agent_files.rs` | 1339 | 路径安全校验（is_safe_path 类纯函数集中）+ 目录列举 + 文件读写三模块；安全校验优先补测 |
| `working_payment.rs` | 1144 | 拆 `working_payment/flow.rs`（创建/复用/取消）、`poller.rs`（轮询和重启恢复）、`mapping.rs`（worker 响应转换）；能力发放/撤销与账号上下文保持成对，不增加未存在的回调验签逻辑。 |
| `auth_session.rs` | 991 | token 校验与会话存储分离 |
| `pi_rpc.rs` | 1001 | worker 进程管理（spawn/finish/capability 撤销）与 RPC 帧编解码分离；capability 生命周期规则（启动前注入、所有失败路径撤销）必须集中在单一模块便于审计 |
| `alipay_bot.rs` | 901 | 按现有 CLI 桥接拆 `alipay_bot/request.rs`（输入校验和参数）、`command.rs`（子进程与临时文件）、`output.rs`（输出脱敏、二维码和 JSON 解析）；入口保留 `handle_request`，不凭文件名新增回调验签层。 |
| `payment_workspace.rs` | 862 | 拆 `payment_workspace/paths.rs`（规范化/符号链接/私有权限）、`config.rs`（环境配置）、`workspace.rs`（工作区管理）；保留路径安全与账号隔离，不在未证明语义相同时抽取跨支付域通用类型。 |
| `working_gateway.rs` | 929 | 上游请求转发与响应映射分离 |
| `workspace_dev.rs` | 845 | 项目发现（扫 project/ 目录纯逻辑）、端口分配持久化、dev server 启动三段拆分 |
| `automation.rs` | 1013 | tick 调度与任务存储分离；顺延规则（interval/daily/weekly/monthly 过期顺延、once 待执行）抽纯函数补测 |
| `agent_mail.rs` | 604 | 拆 `agent_mail/request.rs`、`args.rs`、`command.rs`；保留 parse_agent_mail_request、build_agent_mail_args、execute_agent_mail_cli 和 handle_request 的入口契约。当前是邮件 CLI 桥接，不新建 IMAP/SMTP 协议客户端。 |

**测试文件说明**：完整超标测试清单见配套扫描文档。按行为分组并保持测试隔离；新模块增加的测试遵循同目录规范，现有测试不能因源文件迁移而被跳过。

---

## 五、共享包与脚本

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `packages/shared/src/types/agent.ts` | 1862 | 按域拆 `types/agent/`：`events.ts`（AgentEvent）、`sessions.ts`、`messages.ts`、`tools.ts`（ToolIndex/tool-matching 相关）、`ipc-channels.ts`；包入口 `./types` 聚合导出，所有消费方 import 不变。这是全仓库影响面最大的类型文件，拆分前先确认无 `import ... from './types/agent'` 深路径依赖 |
| `packages/shared/src/types/working.ts` | 770 | 登录/订单/支付/模型目录四组接口分文件聚合 |
| `scripts/publish-functional-modules.ts` | 820 | 拆 `scripts/publish/options.ts`、`existing-module-validation.ts`、`binary-inputs.ts`；保留入口 main、已导出函数的 re-export，继续调用已有 manifest/COS 工具，不把其他文件中的打包逻辑复制过来。验证多平台 manifest 保留和单模块发布完整性，测试不访问真实 COS。 |

---

## 六、本轮补齐的当前文件

以下 14 项不在旧修复方案的逐文件表中；新增时间与当时是否已超标未做历史追溯。

| 文件（仓库相对路径） | 行数 | 批次、目标模块和关键回归 |
|---|---:|---|
| `apps/electron/src/renderer/components/trading/FundStockTerminalView.tsx` | 1723 | B4；`trading/terminal/TerminalToolbar.tsx`、`TerminalTabs.tsx`、`TradingAiDock.tsx`、`useTerminalQuotes.ts`；继续复用现有 K 线、搜索和自选组件。验证快速切换标的时旧请求不覆盖新标的、订阅清理和 AI 会话选择。 |
| `apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts` | 1433 | B3；`hooks/agent-events/payload-to-events.ts`、`stream-events.ts`、`completion-events.ts`、`interaction-events.ts`。入口只订阅一次，子模块接收 store/上下文；验证不同 session/run 隔离、重试、完成幂等及取消订阅。 |
| `scripts/prepare-dsh-module.ts` | 1165 | B1；`scripts/dsh/official-package.ts`、`archive.ts`、`composer-patch.ts`、`details-panel-patch.ts`；后者包含的大段注入源码继续按预览与事件功能拆到模板片段，不能搬出后仍 >600 行。保持输出字节、integrity 校验和补丁幂等。 |
| `apps/electron/src/main/lib/browser-workflow-page-executor.ts` | 1157 | B5；`browser-workflow-executor/locator.ts`、`wait.ts`、`actions.ts`；保留 BrowserPagePort 边界。验证 frame/locator 回退、超时、取消、Origin 校验与重复点击防护。 |
| `apps/electron/src/renderer/components/web-browser/LiveTranslatePanel.tsx` | 975 | B4；`live-translate/TranslateSettings.tsx`、`SubtitleList.tsx`、`MeetingMinutes.tsx`、`AudioUpload.tsx`、`useTranslateSession.ts`；复用现有 LiveTranslateClient 和 atoms。验证停止/卸载后关闭音频与连接，迟到结果不覆盖新任务。 |
| `apps/electron/src/main/lib/browser-workflow-runner.ts` | 973 | B5；`browser-workflow-runner/tab-aliases.ts`、`run-lifecycle.ts`、`step-loop.ts`；唯一 activeRuns 保留在门面。验证 pause/resume/abort、CDP detach 恢复、profile lease 和页签清理均恰好一次。 |
| `apps/electron/src/main/lib/dsh-cordis-service.ts` | 921 | B6；`dsh/port-probe.ts`、`session-cookie.ts`、`profile.ts`、`process.ts`；门面保留唯一启动 Promise 与状态广播。验证旧进程复用/重启、端口占用、cookie 作用域和停止清理。 |
| `apps/electron/src/main/lib/web-password-autofill-script.ts` | 817 | B5；`web-password-script/fields.ts`、`capture.ts`、`fill.ts` 源码模板片段，保留生成器统一组装。验证表单捕获/去重、input/change 派发、登录失败重试和敏感字段不上日志；不改变凭据加密存储。 |
| `apps/electron/src/renderer/components/agent-skills/AgentSkillsView.tsx` | 701 | B4；`agent-skills/SkillsTab.tsx`、`McpTab.tsx`、`SkillSection.tsx`，列表操作继续调用现有 atoms/API。验证内置/用户区分、开关、升级、删除确认与选中状态。 |
| `apps/electron/src/main/lib/dsh-model-config.ts` | 694 | B6；`dsh/provider-config.ts`、`model-defaults.ts`、`model-config-writer.ts`；保留 capability 获取和配置合并契约。验证自定义/Working 模型、推理配置、用户字段保留及密钥不入日志。 |
| `apps/electron/src/main/lib/cdp-session-router.ts` | 693 | B5；`cdp-router/leases.ts`、`pending-commands.ts`、`events.ts`；一个 router 持有 debugger 和状态。验证多 owner 共享连接、释放最后 owner、detach 时拒绝 pending、过期 lease 不可复用。 |
| `native/http-api-server/src/runtime.rs` | 657 | B6；`runtime/paths.rs`、`probes.rs`、`environment.rs`；保留 Node/Python/Git 探测、PATH 顺序和子进程超时回收。用现有 runtime_tests.rs 回归。 |
| `apps/electron/src/main/lib/agent-prompt-builder.ts` | 629 | B3；`prompt/workspace-context.ts` 与 `prompt/system-sections.ts`，保留门面装配；复用已有 memory-context-builder。验证段落顺序、工作区 scope、权限可见性和 token 限制。 |
| `apps/electron/src/preload/dsh-bridge-preload.ts` | 628 | B6；`preload/dsh/theme.ts`、`messages.ts`、`api.ts`；只在入口 expose 一次 copisBridge，保持 postMessage 校验和监听清理；执行 build:preload 检查独立入口产物。 |

## 七、分批实施顺序

本文为覆盖全仓库的拆分路线图：逐文件表确定候选职责，第八节细化入口批次。执行每个服务批次前仍需读取完整实现及调用方，登记精确接口和行为测试；不能把候选模块名当成已验证的完整实现设计。

推荐“保留门面、逐职责迁移”。不采用一次性重写架构，也不按平台复制已有通用逻辑。各表的目标文件为拟新增路径，执行时先检查同名模块并优先复用。下列批次可以包含多个独立小提交，不能把整批视为一个大补丁。

| 批次 | 范围与顺序 | 前置依赖 | 完成条件 |
|---|---|---|---|
| B1 | shared/types/agent、working；pi-model-registry；DSH 构建补丁与发布脚本 | 导出和输出基线 | 旧 import 保持、类型检查通过、模板/manifest 离线测试通过 |
| B2 | ipc.ts + preload/index.ts，按域逐对迁移 | B1 不是硬依赖；不同时重构域服务 | 通道与 API 清单相同、无重复注册、三端构建通过 |
| B3 | channel/session/workspace/config-paths；orchestrator、Pi adapter/tools、RPC、collaboration、prompt；agent-atoms + 全局监听；HTTP 进程/桥接；migration/planning/storage/git/file-preview；主进程入口 | B2 对应域稳定后；先服务纯逻辑再编排 | 会话恢复、并发、权限、失败清理与持久化基线不变 |
| B4 | 全部 renderer/components 超标文件及 renderer/main.tsx，先子组件再交互 hook，最后 ConversationSurface | B3 涉及的 atom/监听稳定 | 测试、类型与 renderer 构建通过；用户实际窗口验收后才关闭 UI 项 |
| B5 | web-tab-manager、CDP、browser-workflow service/runner/executor/script、browser-page-control、browser-agent-tool、autofill | 对应 IPC 不再并行搬动；先 CDP/事件边界再 runner | 生命周期、授权、取消、哈希一致和隔离测试通过；网页交互待用户确认 |
| B6 | feishu/wechat/bridge-command、working-api-client；DSH service/model/preload；Rust runtime | 复用稳定门面，不把桥接协议顺便统一 | 各平台现有消息格式、登录状态、进程/凭据生命周期不变 |
| B7 | Rust main.rs，再逐域 memory/expert_teams/skill_market/agent_files/working_payment/auth_session/pi_rpc/alipay_bot/payment_workspace/working_gateway/workspace_dev/automation/agent_mail | 先 HTTP 通用解析/响应，再路由；后存储内部 | cargo check/test；鉴权、流式、事务和工作区隔离基线不变 |
| B8 | 19 个超标测试/E2E 文件按 fixture、行为场景拆分，可随被测模块逐步处理 | 相关生产模块稳定 | 测试发现数量及断言保留；各测试文件独立可运行 |

类型文件属于跨仓库影响面较大、但易静态验证的迁移，不标为无风险。安全、支付、进程与全局监听属于高风险；遇到相邻未提交变更时基于当前内容工作，不覆盖他人修改。

## 八、首批入口的具体执行计划

### B2：ipc.ts 与 preload 配对迁移

当前真实入口是 `registerIpcHandlers(): void`，保留在 `apps/electron/src/main/ipc.ts`；不要沿用旧设计中未存在的 `registerAllIpcHandlers(mainWindow)` 作为对外 API。

拟新增目录及文件（其余域以同样方式逐个登记）：

- `apps/electron/src/main/ipc/runtime.ipc.ts`：基础运行时与环境；从简单域建立迁移范例。
- `apps/electron/src/main/ipc/web-tabs.ipc.ts`：网页、收藏与密码相关注册，必要时再拆 bookmarks/passwords，避免同域再超标。
- `apps/electron/src/main/ipc/browser-workflow.ipc.ts`：工作流接口。
- `apps/electron/src/main/ipc/working-auth.ipc.ts`、`working-models.ipc.ts`、`working-payment.ipc.ts`：分开 Working 大块。
- 后续 `agent-sessions.ipc.ts`、`agent-workspaces.ipc.ts`、`agent-files.ipc.ts`、`integrations.ipc.ts`、`memory.ipc.ts`、`automation.ipc.ts`、`settings.ipc.ts`；集成再按平台拆，避免 misc 成为新大文件。
- `apps/electron/src/preload/api/runtime.ts`、`web-tabs.ts`、`browser-workflow.ts` 及上述各业务同名分片：返回现有 invoke/listener 方法；原入口仍只 expose 一次。
- `apps/electron/src/main/ipc-registration.test.ts` 与 `apps/electron/src/preload/api-contract.test.ts`：拟新增行为测试；现有 `ipc-workspace-search.test.ts`、`lib/web-tab-ipc-contract.test.ts` 继续保留。

子注册器采用 `registerRuntimeIpcHandlers(): void` 一类具名函数，直接导入原服务。只有确有跨模块状态时才声明最小的类型化参数，不把所有服务塞入一个巨型 context。

- [ ] 提取迁移前通道名、invoke 参数、事件回调和清理函数清单；mock ipcMain/ipcRenderer 收集注册及调用，基线先通过。
- [ ] 建立 Given 已初始化 / When 调用运行时 API / Then 相同通道与参数只调用一次的测试；Given 已订阅 / When cleanup / Then 同一 listener 被移除。
- [ ] 只迁移 runtime 注册与 preload 分片；原处理器体不改逻辑，删除原注册后调用一次子注册器。
- [ ] 比较迁移前后完整通道/API 键集合；排查对象 spread 覆盖同名键，确认服务初始化和监听顺序未变。
- [ ] 执行第九节 TS 与 IPC 检查；通过后依次迁移 web-tabs、browser-workflow、Working 三片和剩余域，每次重复契约校验。
- [ ] 达到旧入口及各新文件 ≤600 行；保留旧 import 路径，不要求调用者全仓替换。

### B3/B4：其余三个 Top 文件

- [ ] `agent-orchestrator.ts`：先抽 `orchestrator/error-mapper.ts`、`retry-policy.ts`，再抽标题/事件持久化/运行准备。门面保留并发守卫、运行标识和 abort 所有权；不要将 sendMessage 的可变状态复制到多个对象。Given 同会话重复发送 / Then 并发规则不变；Given 重试后迟到事件 / Then 不污染新 run；Given 中断 / Then 子进程与监听回收。
- [ ] `AgentConversationSurface.tsx`：新建 `conversation/useConversationSend.ts`、`useConversationAttachments.ts`、`useConversationHistoryActions.ts`、`useConversationQueue.ts`；组件继续装配现有消息/输入组件。Given 切换会话或 fork/rewind / Then 草稿、队列与权限归属不串会话。ref、effects 和闭包依赖在每个小步核查。
- [ ] `preload/index.ts`：由 B2 同步收口；不得先把所有 API 搬到一个仍超标的新对象文件，也不删取消订阅返回值。

### B7：Rust main.rs

- [ ] 新建 `http/request.rs`、`http/response.rs`、`http/encoding.rs` 和 `http/mod.rs`，原样迁移请求解析与响应；新建同目录 `request_test.rs` 等测试并登记模块。
- [ ] Given chunked/非法请求/OPTIONS / When 解析与响应 / Then 状态码、头、body 和限制不变；保留 SSE 输出时机与断开处理。
- [ ] 新建 `routes/memory.rs`、`routes/recording.rs`、`routes/agent_stream.rs`、`routes/working.rs` 与 `routes/mod.rs`，逐域迁移到 `router.rs` 分发。main.rs 保留启动、共享 Bridge 及连接接入编排。
- [ ] 鉴权在分发前继续执行，先确认原判断顺序及公开/内部路径例外，再考虑独立 auth 模块；不把允许/拒绝逻辑顺便改写。
- [ ] 每域执行 cargo check/test；Given 未授权或跨 workspace 请求 / Then 保持拒绝；Given 连接中断 / Then 流式/录制资源正确清理。
- [ ] 入口收口后再拆各域 SQL 模块，锁、事务及能力生命周期由同一责任方持有。

## 九、验证与交付门槛

以下为后续实施命令，本次文档更新未运行代码测试或构建。仓库根目录执行；新增测试路径在创建后才运行。

```bash
bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer
bun test apps/electron/src/main/ipc-workspace-search.test.ts
bun test apps/electron/src/main/lib/web-tab-ipc-contract.test.ts
bun test scripts/prepare-dsh-module.test.ts
bun test scripts/publish-functional-modules.test.ts
cargo check --manifest-path native/http-api-server/Cargo.toml
cargo test --manifest-path native/http-api-server/Cargo.toml
```

按实际触及的模块选对应测试；全量 TS 回归使用 `bun run test`（scripts/run-tests-isolated.ts），不能与裸 `bun test` 的单进程 mock 语义混同。

浏览器链路还必须分别执行（不同 Bun 进程，避免 config-paths mock 互相污染）：

```bash
bun test apps/electron/src/main/lib/web-bookmark-service.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/cdp-session-router.test.ts
bun test apps/electron/src/main/lib/browser-workflow-page-executor.test.ts
bun test apps/electron/src/main/lib/browser-workflow-runner.test.ts
bun test apps/electron/src/main/lib/browser-workflow-service.test.ts
```

每个小批交付检查：

- [ ] 自动化验证前后结果记录清楚，原有失败不能归入本次成功，也不能删测试绕过。
- [ ] 重新扫描新旧文件，所有被标为完成的门面与新增源码均 ≤600 行；完成记录保留，不直接删除历史行。
- [ ] 公共导出、通道、持久化字段、模板哈希及生命周期无非预期变化。
- [ ] 复查组件化和可读性；执行环境有 code-simplifier 时按 AGENTS.md 运行，缺失时明确说明并人工审查，不能声称已调用。
- [ ] 涉及 UI：用户在实际 Electron 窗口确认普通 HTTP(S) 网页、原生浮层、会话切换及本批交互；自动化通过与用户待验收分别记录。
- [ ] 后续实际提交遵守包 patch 规则；不因验证触发 COS 发布、安装包发布或生产数据迁移。
