# IPC 拆分执行记录

基线：`03679b6b`，worktree `codex/ipc-split-luna`。

## T0

- 已确认 `ipc.ts` 为 5459 行，静态注册点为 376 个 `ipcMain.handle`、5 个 `ipcMain.on`。
- 已确认原导出 `registerIpcHandlers`、`resolveAppIconPath` 和 `registerUpdaterIpc()` 调用存在。
- 已执行 `bun install --frozen-lockfile`，未修改锁文件。
- 已通过：`bun test apps/electron/src/main/lib/web-bookmark-service.test.ts`。
- 已通过：`bun test apps/electron/src/main/lib/web-tab-session-service.test.ts`。
- 已新增 `ipc-tests/registration-inventory.test.ts` 固化基线契约。
- 注册库存测试会展开 `registerWebPasswordsIpcHandlers()`，并验证组合入口的通道顺序、唯一性及 376 个 handle / 5 个 on 基线。

## T1（完成：浏览器域）

- [x] 将 13 个 `WEB_PASSWORD_IPC_CHANNELS` 处理器迁至 `ipc/web-passwords.ipc.ts`；`ipc.ts` 在原注册顺序的位置调用 `registerWebPasswordsIpcHandlers()`。
- [x] 覆盖 list 参数透传、空 ID 短路、`fillCredentials` 获取当前 WebContents 以及服务异常透传。
- [x] 通过：`bun test apps/electron/src/main/ipc-tests/registration-inventory.test.ts apps/electron/src/main/ipc-tests/web-passwords.test.ts`。
- [x] 通过：`bun run typecheck`、`bun run --filter='@copis/electron' build:main`、`build:preload`、`build:renderer` 与 `git diff --check`。
- [x] 将页签生命周期、导航、无痕、排序、边界更新、项目关联和 JavaScript prompt 的 16 个 `WEB_IPC_CHANNELS` 处理器迁至 `ipc/web-tabs.ipc.ts`。
- [x] 由于原处理器与收藏夹处理器交错，按原顺序调用 core、navigation、project 三个注册函数；注册集合和顺序摘要保持基线一致。
- [x] 覆盖页签列表、重排输入校验以及 JavaScript prompt 的 sender ID 传递。
- [x] 将收藏夹窗口与存储的 9 个 `WEB_BOOKMARK_IPC_CHANNELS` 处理器迁至 `ipc/web-bookmarks.ipc.ts`；继续在原注册位置调用窗口与存储子注册器。
- [x] 将 Browser Workflow 的 13 个处理器和状态订阅迁至 `ipc/browser-workflow.ipc.ts`，保留主窗口 sender 校验和 `STATUS_CHANGED` 广播。
- [x] 新增页面、收藏夹、密码和 Browser Workflow 的注册行为测试；注册库存递归展开所有新注册器，保持 376 个 handle、5 个 on 及既有顺序摘要。
- [x] 通过全部 IPC 注册测试、网页收藏、页签会话、页签 manager 和 IPC contract 测试；通过 `bun run typecheck`、main/preload/renderer 构建与 `git diff --check`。

## T2（完成：账号与系统）

- [x] 原样迁移 Working 账号 19 个、支付 9 个、模型 4 个处理器到三个注册模块，保留参数类型、输入校验与认证刷新顺序。
- [x] 将账号、模型与设置共用的权限读取移至 `lib/working-model-catalog-access.ts`，避免注册模块相互依赖。
- [x] 通过所有 IPC 注册测试、Working API client 和模型目录服务测试、全仓类型检查、main/preload 构建以及 diff 检查。
- [x] 完成 channels、runtime、settings、scratch-pad、window 和 voice 域；分散的注册段在原位置调用具名子注册器，主题监听仍随设置段注册。
- [x] 图标路径辅助函数迁至 `lib/app-icon-path.ts`，原 `ipc.ts` 继续 re-export；打包后的资源解析保持不变。
- [x] 对照基线 AST 确认 T2 全部 95 个 handle/on 调用实现一致，仅归一化迁移后的相对 import 路径；全局仍为 376 handle / 5 on，顺序与唯一性通过。
- [x] 新增 OAuth 取消与设备码回传、功能模块进度存活检查、同步设置权限过滤/广播/失败返回、Scratch Pad 临时文件同步写入、窗口路由和语音 sender/取消顺序回归。
- [x] 设置服务旧测试触发 Electron 下载超时，已改用临时配置目录和 Electron mock，重跑通过；没有修改设置服务实现。
- [x] main/preload/renderer 构建通过，renderer 保留 Browserslist、混合导入和大 chunk 的既有警告。新增注册文件均小于 600 行，当前 `ipc.ts` 为 4128 行。
- 代码简化复核：合并重复导入、删除失效导入与多余空行；保留直接业务注册，未增加服务定位器。环境未提供 code-simplifier，已人工复核。

## T3（完成：文件与 Git）

- [x] 将 63 个处理器迁入 git、system-files、attachments、attached-paths、agent-files、file-preview 六个域。交错注册段分别从原位置调用，通道数量、顺序及唯一性保持基线。
- [x] 提取文件授权、附加目录监听引用检查、默认应用缓存、Windows 注册表解析、外部命令与内置资源路径 helper；保留原函数行为及动态 import。
- [x] 对照 HEAD 的 AST，全部迁移 handle/on 实现一致，仅归一化相对 import 路径。
- [x] 全部 IPC 测试通过；新增真实 symlink 越界、真实外部 Git worktree、候选路径不授予权限、共享监听最后引用释放、拒绝写入/删除、预览大小限制及 Windows/macOS 参数校验回归。
- [x] 通过 ipc-workspace-search、file-access-policy、file-preview-service、attached-paths 服务测试，以及全仓 typecheck、main/preload/renderer 构建和 diff 检查。
- [x] 新增注册模块最大 406 行；`ipc.ts` 当前 2424 行。已人工进行简化复核，清理迁移后遗留说明，未改变访问策略；code-simplifier 工具仍不可用。
- Windows/macOS 分支的自动化验证使用 mock，实际默认应用、Terminal、预览窗口及文件交互仍待用户在对应系统确认。

## T4（完成：Agent）

- [x] 迁移 sessions、workspaces、capabilities、execution、interactions 与 tools，70 个处理器保持原实现；执行与权限交错段仍在原位置注册。
- [x] 提取共享 runtime 校验；覆盖取消、Fast Mode 并发守卫、重复权限答复、审批广播、会话清理、项目删除和创建失败回滚。

## T5（完成：外部集成）

- [x] 迁移飞书、钉钉、微信、邮箱、交易与 DSH；保持旧单 Bot 兼容与 broadcaster 初始化位置。
- [x] 兼容 Bot 选择、邮箱取消、DSH 跳过已销毁窗口等 6 个行为测试通过。

## T6（完成：计划与数据）

- [x] 迁移 planning、automation、memory-ingestion、storage 与 migration。
- [x] Todo 启动仍同步返回，乐观锁冲突不写入；非法定时参数在写入前拒绝；导入取消目录范围和文件对话框取消行为保持原样。

## T7（完成：启动收口）

- [x] 启动维护分为归档与存储清理两个函数，在原位置调用；导入无副作用。覆盖立即归档、24 小时计时器、清理开关与异常捕获。
- [x] `ipc.ts` 从 5459 行降至 180 行；所有新增手写源文件及测试均不超过 600 行，最大注册模块为 406 行。
- [x] 全部 381 个 handle/on 调用 AST 与 HEAD 一致（仅归一化相对 import 路径）；注册库存仍为 376 handle / 5 on，集合、顺序、唯一性、原导出与 updater 注册通过。
- [x] 全部 IPC 分进程测试、语音与飞书设置契约测试通过；旧静态契约测试已改为读取对应新模块。
- [x] 全仓 typecheck、main/preload/renderer、DSH preload、JavaScript prompt preload 构建及 diff 检查通过。
- 独立代码审查未发现 T4–T7 启动及注册顺序行为回归。人工复核导入方向、重复导入与模块职责；环境未提供 code-simplifier。
- 全仓隔离测试未全绿：设计大师 vendor 资源缺失、专家团队颜色令牌契约均已在基线复现；第二次全仓运行还出现 DSH 旧进程回收用例失败，该文件单独复验 14 pass / 0 fail，保留为测试波动记录。飞书和语音旧入口静态检查已修正并定向通过。
- 按用户要求保留 `codex/ipc-split-luna` worktree 全部未提交改动，没有修改 README/AGENTS、提交、合并或发布。

## 2026-09-10 IPC 增量同步

- 来源为主工作区未提交的 `apps/electron/src/main/ipc.ts`；HEAD 为 `03679b6b80bb251623040877207a0f69b3cfa7f4`，文件 blob hash 为 `2a9a89bc57f0ff5811eaef7bd6875f35d9770c95`。
- 将 BIND_CONTEXT 新增日志和 `preserveWorkerCapability: true` 参数同步到浏览器注册模块；沿用 worktree 已支持该参数的服务接口。本轮仅同步 IPC 增量，主工作区其他服务与 UI 改动不属于本次同步范围。
- 更新 BDD 参数透传测试，先确认旧实现因缺少第四参数失败，再同步实现并通过；浏览器注册与库存契约测试 5 项通过。
- 展开后 415 条注册阶段语句与上述主工作区源文件版本一致，注册数量和顺序仍保持 376 handle / 5 on。
- 全仓 typecheck、Electron build:main 与 diff 检查通过；改动继续保留未提交状态。

## 用户验收

- Electron 实际窗口中的网页、收藏夹、密码、Agent、文件预览、设置、语音和外部集成仍需用户确认。
