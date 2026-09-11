# preload/index.ts 按业务域拆分实施计划

> **执行要求**：使用 executing-plans 技能逐任务实施；需要独立实现与审查时使用 subagent-driven-development。每个任务先建立 BDD 特征测试，再迁移和验证。
> **状态**：仅计划，尚未实施。本次不修改生产代码、不递增版本、不提交或合并。
> **原版对照提交**：`4d27ee135f72bf921fb5a651e9ceca8ed93cec94`。
> **对照文件**：`apps/electron/src/preload/index.ts`，2922 行；Git blob hash：`998f9fc3d70c4fa9f390e41db8e394040d34fefd`；文件 SHA-256：`9cc82031f8e0ae681bd038d093a31ed5a4e1ccd25e2656c44bb7509cc078eb6e`。

**目标**：保留完整 `window.electronAPI` 契约，将 preload 入口、接口类型和实现拆为每文件不超过 600 行的模块。

**架构**：`index.ts` 保留启动初始化、API 装配、唯一一次 contextBridge 暴露和兼容类型导出；`api/` 存放具名业务域工厂，`contracts/` 存放对应接口，`runtime/` 存放 HTTP 启动参数初始化。业务服务、HTTP 客户端和主进程 IPC 实现沿用现状。

**技术栈**：TypeScript、Electron contextBridge/ipcRenderer/webUtils、现有 Agent HTTP stream client、Bun 测试和 esbuild CJS bundle。不新增依赖。

**设计依据**：[全仓拆分路线图 B2](../../over-600-lines-fix-plan.md)、[IPC 拆分计划](2026-09-10-ipc-split-plan.md)、[IPC 执行记录](2026-09-10-ipc-split-execution.md)。本计划完成 B2 的 preload 部分，不扩展到主进程服务重构。

## 1. 当前事实与兼容边界

原版可通过固定提交读取，不能在后续迁移中用变化的 HEAD 静默替换基线：

```bash
git show 4d27ee135f72bf921fb5a651e9ceca8ed93cec94:apps/electron/src/preload/index.ts
```

静态 AST 盘点结果（调用点数量，不代表启动时实际执行次数）：

| 项目 | 基线 |
|---|---:|
| ElectronAPI 顶层接口成员 / 实现属性 | 361 / 361 |
| 展开嵌套命名空间后的叶子方法 | 428 |
| ipcRenderer.invoke | 374 |
| ipcRenderer.sendSync / send | 2 / 2 |
| ipcRenderer.on | 46 |
| ipcRenderer.removeListener / off | 44 / 2 |
| exposeInMainWorld('electronAPI', ...) | 1 |

嵌套对象保持原结构：`webTabs` 23、`webPasswords` 14、`browserWorkflow` 14、`updater` 6、`fundStock` 8、`dshCordis` 8 个方法。不能为了内部拆分改成新的渲染端调用路径，也不能以主进程 376 个 handle 数量推导 preload 方法数量。

关键行为：

- `--copis-http-api-port=` 通过 Number 解析，仅整数 1–65535 调用 `agentHttpStreamClient.setBaseUrl`，host 继续使用 `COPIS_HTTP_API_HOST`。
- 初始化先配置端口，再读取 `--copis-http-api-web-token=` 并调用 `setHttpApiWebToken`，随后装配和暴露 API。`getHttpApiWebToken()` 仍按调用时 process.argv 返回值，不改为初始化缓存；原 API 已暴露此 getter，本次不新增或移除令牌能力。
- `sendAgentMessage` 仅 Pi 走 HTTP，其余走原 IPC；`stopAgent` 仅 HTTP 失败后回退 IPC；`queueAgentMessage` 继续走 HTTP。
- `onAgentStreamEvent/Complete/Error/TitleUpdated` 同时订阅 IPC 和 HTTP，取消时必须移除原 IPC listener 并执行 HTTP cleanup。
- `updateSettingsSync`、`saveScratchPadSync` 同步返回；语音音量和 transcript 使用 send，不能改为 invoke。
- 回调不向渲染端透传 Electron event；保留 callback 参数顺序、返回的取消函数，以及 removeListener/off 的原 listener 引用。
- `getPathForFile` 继续调用 `webUtils.getPathForFile`，不改用 File.path 或跨进程文件读取。
- `MigrationExportResult` 当前为本文件私有 interface，随迁移域类型移动；`ElectronAPI` 原导出路径和 Window 全局声明继续可用。

## 2. 全局约束

- 实施前创建新的隔离 worktree，默认分支 `codex/preload-split`；核查实际分支是否已存在。不要复用或重置已有 IPC worktree。
- 当前 main 有其他开发中的未提交文件；计划阶段仅新增本文，实施时记录状态，禁止带入或回退无关修改。
- 不改变主进程 IPC、shared 通道、HTTP client、renderer 业务和独立 preload 的功能；仅当旧静态契约测试因迁移路径失效时调整其读取目标。
- `dsh-bridge-preload.ts` 和 `web-javascript-prompt.ts` 为独立 bundle，本轮不拆它们、不共用入口初始化。
- 不引入通用动态 channel 代理、不暴露 ipcRenderer 对象、不使用服务定位器，不为减少行数把所有 API 搬到另一巨型对象。
- 所有新增手写代码、类型和测试文件 ≤600 行；注释与日志优先中文。保持既有局部类型声明和函数签名，不用 any 或双重断言掩盖类型不兼容。
- README/AGENTS 修改需用户另行授权；本次纯行为保持拆分不自动修改这两份文件。提交时按仓库规则递增受影响 Electron 包 patch，平台发布版本按其独立规则处理。
- Electron UI 的真实交互与视觉最终由用户在实际窗口确认；Agent 不用截图替代验收。

## 3. 文件结构与类型设计

以下路径相对于 `apps/electron/src/preload/`。每行域名同时对应 `api/<域名>.ts`、`contracts/<域名>.ts`，前者导出 `create<前缀>Api()`，后者导出 `<前缀>Api` interface。

| 域名 | 前缀 | 拥有的原 API 职责 |
|---|---|---|
| runtime | Runtime | getHttpApiWebToken、app/runtime、environment、functional module、proxy、tutorial |
| git | Git | 仓库状态、diff、还原、worktree |
| system-files | SystemFiles | external、clipboard、默认应用、编辑器、系统打开、Terminal、getPathForFile |
| web-tabs | WebTabs | 完整 webTabs 命名空间，含收藏夹与页签通知 |
| web-passwords | WebPasswords | 完整 webPasswords 命名空间 |
| browser-workflow | BrowserWorkflow | 完整 browserWorkflow 命名空间 |
| working | Working | Working 账号、业务元数据、支付、模型与 auth 更新通知 |
| channels | Channels | 渠道 CRUD、额度、Codex/XAI OAuth 和设备码事件 |
| settings | Settings | 用户档案、设置及主题事件、图标、角标 |
| scratch-pad | ScratchPad | 普通/同步保存、导出、路径选择、图片剪贴板 |
| attachments | Attachments | 通用附件、资源/记忆导出、文件选择、Agent 保存附件 |
| agent-sessions | AgentSessions | 会话 CRUD、模型/runtime/模式、搜索、分叉、回退、标题生成 |
| agent-execution | AgentExecution | send/stop/queue、后台任务、四种 IPC+HTTP 流事件 |
| agent-workspaces | AgentWorkspaces | 工作区/项目 CRUD、根目录恢复/关联、置顶和排序 |
| workspace-capabilities | WorkspaceCapabilities | MCP/Skill CRUD、导入更新、子文件、能力变更通知 |
| agent-interactions | AgentInteractions | Permission、AskUser、ExitPlan、待处理请求 |
| agent-tools | AgentTools | 工具配置、凭据、测试、自定义工具和变化事件 |
| attached-paths | AttachedPaths | 会话/工作区目录与文件关联、worktree repo 配置 |
| agent-files | AgentFiles | 文件枚举/重命名/移动/删除、附加文件操作、路径类型和搜索；workspace/expert-team 文件变化通知 |
| file-preview | FilePreview | detached preview、clipboard preview、文本/二进制/PDF/Office/截图预览 |
| updater | Updater | 完整 updater 命名空间 |
| feishu | Feishu | 单/多 Bot、绑定、扫码注册、状态事件 |
| dingtalk | DingTalk | 单/多 Bot、OAuth、状态事件 |
| wechat | Wechat | 微信登录、登出、Bridge、状态事件 |
| agent-mail | AgentMail | 邮箱登录/取消/登出和状态事件 |
| window | Window | 窗口控制、resize、菜单、QuickTask、Tray、快捷键 |
| voice-dictation | VoiceDictation | 语音设置、控制、音频、两个 send、状态与文本事件、麦克风权限 |
| migration | Migration | 导出/导入/确认/对话框/打开文件事件，含 migrationCancelImport |
| storage | Storage | 统计和临时/存储清理 |
| automation | Automation | 定时任务 CRUD、立即运行及 changed |
| planning | Planning | 计划窗口、Todo/日历/分组/标签/提醒及所有计划事件 |
| memory-ingestion | MemoryIngestion | 文档解析、网页获取、知识抽取 |
| trading | Trading | 完整 fundStock 命名空间 |
| dsh | Dsh | 完整 dshCordis 命名空间 |

此外新增：

- `contracts/electron-api.ts`：仅通过 interface extends 组合所有分域接口，不含运行时导入和实现。
- `runtime/http-bootstrap.ts`：导出 `initializePreloadHttpRuntime(): void`；保留两个参数前缀及现有初始化逻辑，模块导入本身不设置端口/令牌。供 runtime API 使用的前缀可具名导出，不能把读取行为缓存化。
- `preload-tests/`（与 preload 同属 `src/`）：分域运行测试、入口组合测试、库存基线 fixture 和 Electron/HTTP mock harness。

选用分域接口作为类型源头，避免 `contracts → index → api → contracts` 循环，也不让声明类型依赖实现的 ReturnType。中间阶段可让旧 `ElectronAPI` 逐步 extends 已迁移接口并删除对应旧成员；最终原入口 re-export 聚合接口。

工厂只创建方法对象，不在工厂内注册监听或启动 HTTP；订阅仍由 onXxx 方法在调用时发生。示例（实际方法体逐字迁移）：

```ts
// api/scratch-pad.ts
import { ipcRenderer } from 'electron'
import { SCRATCH_PAD_IPC_CHANNELS } from '../../types'
import type { ScratchPadApi } from '../contracts/scratch-pad'

export function createScratchPadApi(): ScratchPadApi {
  return {
    // 此处展示其中一个方法；迁移时同时保留该域其余原成员。
    saveScratchPadSync: (content: string) =>
      ipcRenderer.sendSync(SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC, content),
  }
}
```

上例是局部形态说明，不能以缺少其他成员的对象交付。入口使用显式工厂装配，`const electronAPI: ElectronAPI = { ...createRuntimeApi(), ... }`；所有属性必须在基线 fixture 中归属唯一工厂。TS 不能独自阻止 spread 覆盖，同名键需在测试中显式检测。嵌套命名空间由一个工厂完整拥有，不跨工厂重复展开覆盖。

## 4. P0：固化原版契约

**文件**：新增 `src/preload-tests/api-inventory.test.ts`、`fixtures/api-baseline.json`、`preload-harness.ts`、`entry.test.ts`；暂不修改生产源码。

- [ ] 确认基线提交、文件 hash、工作区状态。将基线版本与后续新增功能分别记录；不得直接重生成预期值掩盖变化。
- [ ] 用现有 TypeScript AST 读取 ElectronAPI 成员和 electronAPI 对象，生成每个叶子路径、所属顶层键、参数/返回类型、方法体及传输调用清单，保留原 key 顺序；保存固定 JSON fixture。
- [ ] 对照本计划数字验证库存；检查无未知 computed key、重复 key 或遗漏的 nested object。对每个叶子记录 invoke/send/sendSync、HTTP/webUtils 或组合订阅，而非假定全部是 IPC。
- [ ] mock contextBridge 捕获真实导入入口暴露的对象，递归比较 361 个顶层键和 428 个叶子方法，验证 expose 一次且对象不是原始 ipcRenderer。
- [ ] 建立独立进程 harness：捕获 invoke/send/sendSync 参数、on/off/removeListener 引用，模拟事件回调与 HTTP cleanup，备份/恢复 process.argv；测试不连接真实 HTTP 或 Electron。
- [ ] 运行 `bun test apps/electron/src/preload-tests/api-inventory.test.ts` 和 `entry.test.ts`（分别启动），先建立原版通过的基线。

## 5. P1–P7：分批迁移

每批中的每个域按以下独立闭环执行，不等整批搬完才测试：

1. 从固定 fixture 标记本域原属性及类型，建立 `preload-tests/<域名>.test.ts`。
2. 写出调用新 `create<前缀>Api()` 的 BDD 用例，运行确认因模块/工厂尚不存在失败。
3. 提取对应 interface 和方法体；调整相对路径，保留参数注解/返回值、Promise 与同步语义。
4. 原入口在对应位置装配该域，删除原成员；工厂覆盖率测试检查每个 key 只有一个 owner。
5. 运行本域测试、库存/入口测试、typecheck 和 build:preload；比较展开方法 AST，只有导入路径/装配结构可以不同。
6. 复核 diff 和清理函数，记录批次结果。只有用户授权提交时才提交并按包规则升 patch；不自动推送/发布。

| 批次 | 明确文件组（按第 3 节创建 api/contracts 对） | BDD 验收与断言 |
|---|---|---|
| P1 浏览器 | web-tabs → web-passwords → browser-workflow | Given 页签创建/密码请求，When 调用，Then 原参数含 undefined 位置原样透传；Given 两个 onChanged 订阅，When 取消一个，Then 仅移除该 listener，另一个仍收到 payload，Electron event 不暴露 |
| P2 系统与设置 | runtime → git → system-files → channels → working → settings → scratch-pad → updater | Given sendSync 返回对象，Then API 当场返回同一结果且不是 Promise；Given File，Then webUtils 接收同一 File；Given OAuth 设备码，Then callback 和取消链路不变；付款参数与 updater 字符串通道逐项对照 |
| P3 Agent 管理 | agent-sessions → agent-workspaces → workspace-capabilities → agent-interactions → agent-tools | Given session/model/runtime 参数，Then 同一通道与同一顺序；Given MCP/Skill 路径参数，Then 不自行规范化；Given 权限/AskUser/ExitPlan，Then 请求对象完整保留；变化通知取消引用一致 |
| P4 Agent 执行 | agent-execution | Given Pi/DSH/未指定 runtime，Then 分别走原 HTTP/IPC 路径；Given stop HTTP 成功，Then 不调用 IPC；Given HTTP 拒绝，Then 才调用 STOP_AGENT 并透传结果；Given双来源事件，Then两个来源都能回调且取消同时解除两个来源 |
| P5 文件与外部集成 | attachments → attached-paths → agent-files → file-preview → feishu → dingtalk → wechat → agent-mail | Given 多个可选路径参数，Then 数组/undefined 不丢位；Given 旧 Bot 与新 Bot API，Then 分别保持通道和对象；Given 邮箱取消，Then 仅调用取消通道；文件对话框取消返回 null 不改写 |
| P6 窗口与数据 | window → voice-dictation → migration → storage → automation → planning → memory-ingestion → trading → dsh | Given 语音音量/transcript，Then 仅 send 且同步返回；Given 快速任务/Tray/DSH 事件，Then 正确脱去 event 并按原方式取消；Given migration literal channel 和 plan Todo 启动，Then 仍走原 invoke，保留 typed Promise 返回 |
| P7 启动与入口收口 | runtime/http-bootstrap.ts、contracts/electron-api.ts、index.ts、preload-tests/http-bootstrap.test.ts | Given 有效/无效端口，Then 有效值设置同一单例 baseURL、无效值不设置；Given token 参数，Then 按原顺序初始化且不打印 token；Given 导入分域工厂，Then 不监听/配置/暴露；Given 导入入口，Then 初始化先于 expose，所有 key 唯一且完整 |

P2 的 runtime 工厂可以先引用仍位于入口初始化流程所用的同一前缀常量；若需要共享，提前提取仅含常量的模块，或在 P2 原样移动启动 helper 并保留入口调用。不得让 runtime 工厂反向运行时导入 index；P7 对最终初始化位置做完整复核。

P4 必须分别覆盖 event、complete、error、title 四条 cleanup，不仅选一条代表。P6 的 Todo preload 调用本来就是 invoke/Promise；主进程的同步临界区不能误解为需要改成 sendSync。

关键断言形式（harness 捕获真实方法调用，不仅测试 mock 自身）：

```ts
const result = api.saveScratchPadSync('草稿')
expect(result).toBe(syncResult)
expect(result).not.toBeInstanceOf(Promise)
expect(sendSync).toHaveBeenCalledWith(SCRATCH_PAD_IPC_CHANNELS.SAVE_SYNC, '草稿')

const stop = api.onAgentStreamEvent(callback)
const listener = on.mock.calls[0]![1]
listener({}, payload)
expect(callback).toHaveBeenCalledWith(payload)
stop()
expect(removeListener).toHaveBeenCalledWith(AGENT_IPC_CHANNELS.STREAM_EVENT, listener)
expect(cleanupHttp).toHaveBeenCalledTimes(1)
```

- [ ] P0 基线完成。
- [ ] P1 浏览器完成。
- [ ] P2 系统与设置完成。
- [ ] P3 Agent 管理完成。
- [ ] P4 Agent 执行完成。
- [ ] P5 文件与外部集成完成。
- [ ] P6 窗口与数据完成。
- [ ] P7 启动与入口收口完成。

## 6. 验证命令与对照审查

测试各自独立 Bun 进程，避免模块 mock 和 process.argv 相互污染：

```bash
for file in apps/electron/src/preload-tests/*.test.ts; do
  bun test "$file" || exit 1
done
bun test apps/electron/src/renderer/lib/agent-http-stream.test.ts
bun test apps/electron/src/renderer/lib/http-api-web-token.test.ts
bun test apps/electron/src/renderer/lib/http-api-bridge.test.ts
bun test apps/electron/src/renderer/lib/http-api-bridge.contract.test.ts
bun test apps/electron/src/main/ipc-tests/registration-inventory.test.ts
bun run typecheck
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:renderer
bun run --filter='@copis/electron' build:dsh-bridge-preload
bun run --filter='@copis/electron' build:web-javascript-prompt-preload
bun run test
git diff --check
```

- [ ] 固定基线与最终装配递归展开比较全部方法 AST、类型和 key，包括引入的 helper；不能仅比较调用总数。
- [ ] 实际捕获 contextBridge 暴露对象，检测跨工厂重复顶层键与叶子路径；仅用 Object.keys 最终对象无法发现被 spread 覆盖的旧属性，需同时检查每个工厂输出。
- [ ] 核对 import 方向，contracts 无 Electron 运行时依赖，分域不反向导入入口；HTTP 客户端仍是原单例。
- [ ] 查看 dist/preload.cjs 确认新模块已打入单个 CJS bundle，没有运行时加载未打包的本地 TS 文件；不得通过改动 sandbox/contextIsolation 放宽设置来让构建通过。
- [ ] 基线测试失败、环境缺资源和新增回归分别记录；不得按历史结论假设当前失败仍然既有。全仓已有 UI 并行修改时先确认当前状态再定性。
- [ ] 按 AGENTS 要求运行可用的 code-simplifier；若不可用，明确记录并人工复核职责、重复导入、复杂度和 listener 清理。

## 7. 用户验收与交付

- [ ] 所有原 API 和 ElectronAPI 类型导出保持兼容，入口及新增类型/实现/测试均 ≤600 行。
- [ ] 用户在 Electron 实际窗口确认：普通 HTTP(S) 网页、收藏夹与密码；Agent Pi/DSH 发送中断及会话切换；设置与 Scratch Pad 保存；附件/预览；OAuth、语音、QuickTask、Tray 和外部集成。
- [ ] 执行记录写入 `docs/superpowers/plans/2026-09-10-preload-split-execution.md`，逐批登记通过命令、残留失败、用户待验收项及对照 hash。
- [ ] 若实施过程中 main 的 preload 更新，先对比固定基线，将真实增量同步到所属域及测试，追加提交 hash；未提交来源追加 blob hash，不用修改 fixture 隐藏差异。
- [ ] 更新总路线图 B2 状态，保留历史扫描数。只有 IPC 与 preload 自动化验证和用户验收均满足后才关闭整个 B2。
- [ ] 提交、合并、推送与发布遵循当时用户授权；完成计划不等于启动实施。

本文所有任务尚未执行，盘点数字是静态检查结果，不表示迁移测试或构建已通过。
