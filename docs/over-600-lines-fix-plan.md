# 超 600 行代码文件逐文件修复方案

> 配套文档：清单见 `docs/files-over-600-lines.md`；前 5 大文件的详细拆分设计见 `docs/large-file-split-plan.md`（本文不重复，仅引用）。
> 规则来源：AGENTS.md「代码风格」——源代码文件不超过 600 行，新增代码必须遵守，改动存量超大文件时顺势拆分。
> 行数统计日期：2026-08-26（生产代码，不含 `.test.ts`；Rust `*_tests.rs` 为仓库规定的独立测试文件，单独标注）。

## 总览

| 分层 | 超标文件数 | 策略 |
|------|-----------|------|
| Electron 主进程 (`src/main`) | 32 | 按服务职责拆目录/模块，公共 API 不变 |
| 渲染进程组件 (`src/renderer/components`) | 25 | 抽自定义 hooks + 子组件，纯函数外移补测 |
| Preload / IPC 入口 | 2 | 与主进程 IPC 注册器配对迁移（方案 1+5） |
| Rust HTTP API (`native/http-api-server/src`) | 13 | 按 router 域拆模块，测试保持同目录 `*_tests.rs` |
| 共享包 (`packages/shared`) | 2 | 类型按域分文件，聚合导出保持 import 路径不变 |
| 根脚本 | 1 | 按发布阶段拆函数模块 |

**通用原则（适用于所有文件）**：
1. 对外公共 API / 导出签名不变，调用方零改动，可灰度迁移。
2. 优先抽「纯逻辑 + 可单测」的部分先行（错误映射、解析、格式化、常量）。
3. 每步拆分后跑 `bun run typecheck` + 相关 `bun test`；UI 改动由用户在真实窗口验收。
4. 落地后递增受影响包 patch 版本。

---

## 一、前 5 大文件（详细方案已存在）

| 文件 | 行数 | 方案 |
|------|-----:|------|
| `apps/electron/src/main/ipc.ts` | 5275 | → 方案 1：按业务域拆 `main/ipc/*.ipc.ts` 注册器 |
| `native/http-api-server/src/main.rs` | 3713 | → 方案 2：拆 `http/` + `router.rs` + `routes/*` |
| `AgentConversationSurface.tsx` | 3171 | → 方案 3：交互逻辑抽 `conversation/use*.ts` hooks |
| `agent-orchestrator.ts` | 2815 | → 方案 4：`sendMessage` 分解到 `orchestrator/` 协作单元 |
| `preload/index.ts` | 2745 | → 方案 5：按域组合 `api/*.ts` 分片 |

---

## 二、Electron 主进程（`apps/electron/src/main`）

### 大型集成桥接（>900 行）

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `lib/feishu-bridge.ts` | 2593 | 拆为 `feishu/` 目录：`hermes-register.ts`（扫码注册）、`message-sync.ts`（双向同步）、`task-notify.ts`（任务通知）、`crypto.ts`（加解密辅助）；`feishu-bridge-manager.ts` 保持门面。命令路由部分并入现有 `bridge-command-handler.ts` |
| `lib/adapters/pi-agent-adapter.ts` | 2147 | 拆为 `adapters/pi/`：`session-lifecycle.ts`（创建/恢复/中断/分叉/回退）、`tool-bridging.ts`（原生工具+MCP+Skills+权限）、`model-builder.ts`（按 ProviderType 构建模型）、`default-extensions.ts`（已有，迁入）；`PiAgentAdapter` 类保留为薄门面 |
| `lib/wechat-bridge.ts` | 973 | 拆 `wechat/`：`ilink-login.ts`（扫码登录）、`long-connection.ts`（长连接监听与重连）、`message-dispatch.ts`；配置读写已在 `wechat-config.ts` 不动 |
| `lib/bridge-command-handler.ts` | 916 | 命令路由改为注册表模式：每平台一个 `commands/{feishu,wechat,dingtalk}.commands.ts`，handler 只做查表分发；信封剥除逻辑下沉 shared utils 并补单测 |

### Agent 核心链路

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `lib/agent-workspace-manager.ts` | 1990 | 拆 `workspace/`：`workspace-crud.ts`、`mcp-config.ts`（MCP JSON 读写）、`skills-config.ts`、`skills-upgrade.ts`（`upgradeDefaultSkillsInWorkspaces` semver 同步，独立可测）；manager 保留编排门面 |
| `lib/channel-manager.ts` | 1983 | 拆：`channel-crypto.ts`（AES-256-GCM/safeStorage，纯逻辑优先抽并补测）、`channel-store.ts`（CRUD + channels.json 持久化）、`channel-connectivity.ts`（连接测试、模型获取）；`ChannelManager` 门面不变 |
| `lib/agent-session-manager.ts` | 1661 | 拆：`session-jsonl-store.ts`（JSONL 追加/读取，纯 IO 可测）、`session-meta-store.ts`（索引 CRUD + 置顶）、`bridge-sessions.ts`（飞书/微信/钉钉专属会话与模型继承） |
| `lib/http-api-handler.ts` | 1410 | 与 Rust 侧方案对齐：按 `/api/*` 前缀拆 handler 模块（memory/workspace-dev/automation/expert-team/internal-bridge），公共 token 校验与响应封装抽 `http-common.ts` |
| `lib/browser-workflow-service.ts` | 1342 | 拆：`recording-state-machine.ts`（状态迁移，纯逻辑补测）、`draft-validator.ts`（Draft 重校验）、`jsonl-sanitizer.ts`（脱敏序列化）；service 保留 IPC 编排 |
| `lib/agent-rpc-service.ts` | 924 | 按消息方向拆：`rpc-request-mapper.ts`、`rpc-event-mapper.ts`（映射纯函数补测），service 缩为 stdio 会话管理 |

### 工具与运行时支撑

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `lib/adapters/pi-builtin-tools.ts` | 1150 | 每组内置工具一个文件：`tools/file-tools.ts`、`tools/browser-tools.ts`、`tools/memory-tools.ts` 等，注册表聚合；工具 schema 与执行分离 |
| `lib/agent-collaboration-tools.ts` | 1086 | 按协作能力拆：子智能体派发 / Browser Workflow 总结 / 任务交接三块，各自独立导出工具定义 |
| `lib/web-tab-manager.ts` | 1076 | 拆 `web-tabs/`：`view-lifecycle.ts`（创建/销毁/isDestroyed 防护）、`bookmarks-window.ts`（收藏夹原生窗口）、`tab-session-persist.ts`；释放竞态检查逻辑集中一处 |
| `lib/migration-service.ts` | 1266 | 改为版本化迁移注册表：`migrations/v{N}.ts` 每版本一文件 + runner 循环执行；每个迁移步骤可独立测试 |
| `lib/working-api-client.ts` | 920 | 按端点域拆 `working-api/`：`auth.endpoints.ts`、`orders.endpoints.ts`、`payment.endpoints.ts`、`model-catalog.endpoints.ts`，共享 fetch 封装留 client 本体 |
| `lib/config-paths.ts` | 892 | 「路径解析」与「seed/upgrade 副作用」（`seedDefaultSkills` 等）分离为 `config-paths.ts`（纯函数）+ `default-skills-seeder.ts`（IO 副作用），便于测试 mock |
| `lib/http-api-server.ts` | 849 | 拆：`http-api-process.ts`（子进程 spawn/退出处理）、`http-api-env.ts`(env 注入组装，纯函数)、health/ready 探测独立 |
| `lib/adapters/pi-model-registry.ts` | 760 | 模型目录数据（静态表）与解析逻辑分离：`pi-models.data.ts` 常量表 + `pi-model-registry.ts` 查询函数 |
| `index.ts`（入口） | 750 | 拆出 `app/window-factory.ts`（主窗口创建）、`app/single-instance.ts`、`app/lifecycle-hooks.ts`；入口只保留启动顺序编排 |
| `lib/git-diff-service.ts` | 741 | git 命令封装（exec 辅助）与 diff 解析/格式化分离，解析纯函数补测 |
| `lib/file-preview-service.ts` | 711 | 按预览类型拆 provider（图片/PDF/文本/Office），注册表分发 |
| `lib/browser-page-control-service.ts` | 660 | 操作校验（nonce/Origin/isTrusted）抽 `page-action-guard.ts` 纯函数层，service 缩为执行层 |
| `lib/storage-service.ts` | 637 | 统计计算（纯遍历汇总）与清理执行（删除副作用）分离 |
| `lib/browser-agent-tool-service.ts` | 630 | 工具参数校验与 capability 判定抽纯函数模块（对应已有测试直接迁移） |
| `lib/planning-manager.ts` | 624 | 计划 CRUD 存储与冲突检测（`PLANNING_CONFLICT_ERROR` 相关纯逻辑）分离 |
| `lib/browser-workflow-playwright-script.ts` | 610 | 属于内嵌脚本模板字符串，移至 `resources/` 或 `scripts/templates/playwright-replay.ts` 常量文件即可，无逻辑拆分 |

---

## 三、渲染进程（`apps/electron/src/renderer`）

### atoms / 入口

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `atoms/agent-atoms.ts` | 1316 | 按关注点拆 `atoms/agent/`：`sessions.ts`、`stream-state.ts`、`permissions.ts`（权限/AskUser Map 队列）、`workspaces.ts`；`index.ts` 聚合 re-export，调用方 import 路径不变。注意 `composer-history.ts` 已是拆分范例可参考 |
| `main.tsx` | 1161 | 各 Initializer 已存在，把剩余顶层启动逻辑（全局错误边界、Provider 组装、平台守卫）抽 `bootstrap/app-providers.tsx`、`bootstrap/global-error-boundary.tsx`，main.tsx 缩为 ~200 行装配 |

### 大型组件（>800 行，hooks 下沉为主策略）

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `components/agent/SDKMessageRenderer.tsx` | 1474 | 按 SDKMessage type 拆子渲染器目录 `sdk-renderers/`：text/tool_use/tool_result/thinking/error 各一文件 + 注册表分发；共享格式化纯函数外移补测 |
| `components/diff/DiffTabContent.tsx` | 1438 | 拆 `diff/tab/`：`DiffToolbar.tsx`、`DiffFileList.tsx`、`DiffHunkView.tsx` + `useDiffData.ts` hook；与已有 `DiffChangesList.tsx` 复用合并 |
| `components/agent/SidePanel.tsx` | 1361 | 按 section 拆子组件（会话列表/项目列表/队列消息/后台任务），每个 section 一个文件 + 数据 hook |
| `components/ai-elements/rich-text-input.tsx` | 1254 | 拆：TipTap extension 配置 → `rich-text/extensions.ts`、菜单/工具条 → `rich-text/EditorToolbar.tsx`、历史导航（已有 `composer-history` atom）相关 handler → hook；已有 contract test 作回归基线 |
| `components/diff/markdown-preview-extensions.tsx` | 1189 | 每个 markdown 插件（代码高亮/mermaid/math/task-list…）独立文件 + 聚合数组导出 |
| `components/automation/AutomationFormView.tsx` | 1122 | 表单字段区块拆子组件 + `useAutomationForm.ts`（校验/提交纯逻辑外移补测） |
| `components/file-browser/FileBrowser.tsx` | 1031 | 文件树节点渲染、面包屑、预览面板拆子组件；树构建纯函数外移（配合已有 FileDropZone） |
| `components/web-browser/WebBrowserSurface.tsx` | 914 | 工具栏/页签条/侧栏恢复逻辑拆子组件与 hooks；遵守 AGENTS.md 原生页签约束章节 |
| `components/ai-elements/message.tsx` | 819 | 按 role/content 形态拆分支渲染子组件 |
| `components/agent/AgentMessages.tsx` | 821 | 自动滚动/虚拟化逻辑抽 `useMessageListScroll.ts`；单条消息项已是子组件则继续细分 |
| `components/app-shell/CopisWorkingMessageSettingsPanel.tsx` | 1048 | 设置分区各成一个 section 组件（已有 working-settings-menu-contract.test 作基线） |
| `components/app-shell/CopisWorkingSidebar.tsx` | 772 | 导航区/账户区/订单入口拆子组件 |
| `components/ui/image-editor.tsx` | 716 | canvas 绘制操作抽 `image-editor/canvas-ops.ts` 纯函数（坐标变换/裁剪计算可测），React 层只留交互 |
| `components/memory/MemoryImportView.tsx` | 745 | 解析预览卡片、结果统计卡拆子组件；`memory-import-parser.ts` 已独立，视图只做展示 |
| `components/app-shell/CopisWorkingPaymentModal.tsx` | 701 | 二维码展示/订单状态轮询（hook）/套餐选择拆分 |
| `components/voice-dictation/VoiceDictationApp.tsx` | 676 | 录音控制（MediaRecorder 封装）抽 `useVoiceRecorder.ts`，波形/文本区拆子组件 |
| `components/agent/ContentBlock.tsx` | 693 | 按 block type 分支拆小渲染器，与 ContentBlock 注册表并列 |
| `components/web-browser/WebBookmarksPopover.tsx` | 693 | 树形 UI 节点组件与展开状态管理（渲染进程态）拆分；持久化模型（groupId）不动，遵守浮层窗口全部实现约束 |
| `components/expert-team/ExpertTeamView.tsx` | 627 | 团队列表/成员详情/运行状态拆子组件 |
| `components/app-shell/CopisWorkingSettingsPanel.tsx` | 618 | 同 CopisWorking 系列：section 化 |
| `components/agent/AskUserBanner.tsx` | 618 | 选项渲染/表单型问答/超时逻辑拆分，选项归一化纯函数补测 |
| `components/app-shell/SearchDialog.tsx` | 603 | 搜索匹配打分（纯函数）与对话框 UI 分离 |

---

## 四、Rust HTTP API（`native/http-api-server/src`）

除 `main.rs`（方案 2）外，其余超标文件多为「单域完整实现」，拆分方向统一为**域内三层**：`存储/SQL` ↔ `业务逻辑` ↔ `HTTP 解析与响应`，测试保持同目录同名 `*_tests.rs`：

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `memory.rs` | 2217 | 拆 `memory/` 模块目录：`store.rs`（SQLite 仓储 + revision 乐观锁）、`maintenance.rs`（consolidation/promote/archive 决策）、`http.rs`（路由壳与请求/响应映射）；`memory_tests.rs` 相应按模块迁移为 `*_tests.rs` |
| `expert_teams.rs` | 1333 | `store.rs` / `team-runtime.rs`（团队执行流）/ `http.rs` |
| `skill_market.rs` | 1206 | 商品/订单/鉴权响应解析（`parse_auth_working_response` 类）三段拆分 |
| `agent_files.rs` | 1194 | 路径安全校验（is_safe_path 类纯函数集中）+ 目录列举 + 文件读写三模块；安全校验优先补测 |
| `working_payment.rs` | 1126 | 支付网关请求构造、回调校验、订单状态机拆分；对应 `working_payment_tests.rs` 保持覆盖 |
| `auth_session.rs` | 958 | token 校验与会话存储分离 |
| `pi_rpc.rs` | 954 | worker 进程管理（spawn/finish/capability 撤销）与 RPC 帧编解码分离；capability 生命周期规则（启动前注入、所有失败路径撤销）必须集中在单一模块便于审计 |
| `alipay_bot.rs` | 901 | 回调签名验证（纯函数）与 bot 消息处理分离 |
| `payment_workspace.rs` | 863 | 与 working_payment 共享的订单类型/校验抽 `payment_common.rs` 去重 |
| `working_gateway.rs` | 855 | 上游请求转发与响应映射分离 |
| `workspace_dev.rs` | 845 | 项目发现（扫 project/ 目录纯逻辑）、端口分配持久化、dev server 启动三段拆分 |
| `automation.rs` | 614 | tick 调度与任务存储分离；顺延规则（interval/daily/weekly/monthly 过期顺延、once 待执行）抽纯函数补测 |
| `agent_mail.rs` | 608 | IMAP/SMTP 客户端封装与邮件→会话映射逻辑分离 |

**测试文件说明**：`working_payment_tests.rs`(1096)、`agent_files_tests.rs`(900)、`main_tests.rs`(691)、`memory_tests.rs`(629) 是符合仓库规则的独立测试文件，**不强制拆分**；随被测模块迁移时同步移动即可。

---

## 五、共享包与脚本

| 文件 | 行数 | 修复方案 |
|------|-----:|----------|
| `packages/shared/src/types/agent.ts` | 1787 | 按域拆 `types/agent/`：`events.ts`（AgentEvent）、`sessions.ts`、`messages.ts`、`tools.ts`（ToolIndex/tool-matching 相关）、`ipc-channels.ts`；包入口 `./types` 聚合导出，所有消费方 import 不变。这是全仓库影响面最大的类型文件，拆分前先确认无 `import ... from './types/agent'` 深路径依赖 |
| `packages/shared/src/types/working.ts` | 680 | 登录/订单/支付/模型目录四组接口分文件聚合 |
| `scripts/publish-functional-modules.ts` | 658 | 按 COS 发布阶段拆 `scripts/publish/`：manifest 合并、node-runtime 打包、officecli 校验、上传重试；密钥读取保持在入口 |

---

## 六、建议实施顺序

1. **第一批（低风险热身）**：纯函数抽取类 —— `retry-policy/error-mapper`（方案 4 前置）、`shared/types/agent.ts` 拆分、`markdown-preview-extensions.tsx`、`browser-workflow-playwright-script.ts`。
2. **第二批（主链路）**：方案 1+5 的 ipc/preload 分阶段配对迁移（webTabs → browserWorkflow → working → …）。
3. **第三批（服务层）**：`channel-manager`、`agent-session-manager`、`workspace/`、`orchestrator/`（方案 4 全量）。
4. **第四批（集成与 UI）**：`feishu/`、`wechat/`、`bridge commands` 注册表化；渲染进程大组件 hooks 下沉。
5. **第五批（Rust）**：方案 2 的 main.rs，再逐域拆 `memory/`、`pi_rpc/`、`workspace_dev/` 等。
6. 每完成一个文件即从本清单勾销，并递增对应包 patch 版本。

> 维护约定：行数为快照值，落地时以实际扫描为准；新文件一律 ≤600 行，存量文件遵循「改到就拆」。
