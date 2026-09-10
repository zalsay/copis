# ipc.ts 按业务域拆分实施计划

> 状态：仅计划，尚未实施。
> 执行方式：按 executing-plans 技能逐任务执行和验证；每次只迁移一个业务域。
> 基线：2026-09-10，`apps/electron/src/main/ipc.ts` 为 5459 行，直接包含 376 个 `ipcMain.handle` 和 5 个 `ipcMain.on` 调用；另调用 `registerUpdaterIpc()`。这些是静态调用点数量，不包含更新模块内部注册。

**目标**：将主进程 IPC 入口拆成职责明确、每文件不超过 600 行的模块，保持现有行为、调用接口和初始化顺序。

**架构**：保留 `ipc.ts` 作为唯一对外注册入口，子模块按业务域导出具名注册函数。平台适配、文件访问校验、启动维护任务分别迁移，业务服务仍由现有 `main/lib/` 实现。

**技术栈**：TypeScript、Electron、Bun 测试；渲染进程继续使用 React/Jotai。本次不引入依赖。

**设计依据**：[全仓拆分路线图](../../over-600-lines-fix-plan.md)、[当前扫描清单](../../files-over-600-lines.md)以及仓库 AGENTS.md。历史 Top 5 方案中带 mainWindow 参数的新入口不适用于当前代码。

## 1. 范围与兼容边界

- 主修改文件：`apps/electron/src/main/ipc.ts`；新增模块位于 `apps/electron/src/main/ipc/`、必要的 `main/lib/` 和 `main/app/`。
- 保留 `registerIpcHandlers(): void` 和 `resolveAppIconPath(variantId: string): string | null` 的原导出路径及签名；后者可以 re-export。
- 不删除旧 `ipc.ts`，不新建同职责的 `ipc/index.ts`，避免两个聚合入口和解析歧义。
- 不改变通道字符串、invoke 参数顺序、返回值、异常处理、同步事件的 `event.returnValue`、广播目标及事件载荷。
- 不同时拆 preload、共享类型或业务服务。它们是兼容验证对象；仅当测试暴露必要修改时调整测试或导入，不扩展为跨层重构。
- 保留已有延迟 import；不能因迁移提前创建服务、读取用户配置或导入主窗口入口，避免启动时序变化和循环依赖。
- 保留路径范围检查、sender 校验、窗口存活检查；不能把原有安全判断放到渲染进程。
- 不修改存储格式、Jotai 状态、功能模块发布流程、用户数据或依赖版本。
- 提交代码时按 AGENTS.md 递增受影响包 patch；不按每个搬移文件递增。本文生成不提交、不改版本。
- 后续若需修改 AGENTS.md/README.md，按仓库要求取得用户允许。Electron 交互和视觉由用户在实际窗口确认，不使用截图替代。

## 2. 模块布局

下表路径相对于 `apps/electron/src/main/`。均为拟新增模块；实施前检查是否已有等价实现，优先复用。注册函数命名采用 `registerWebTabsIpcHandlers` 等具名形式。

| 目标文件 | 迁移职责 | 关键约束 |
|---|---|---|
| `ipc/web-tabs.ipc.ts` | 页签生命周期、导航、排序、尺寸、无痕、项目关联、JS prompt | 保留原生窗口和 sender 校验 |
| `ipc/web-bookmarks.ipc.ts` | 收藏/分组、独立收藏夹窗口 | parent、尺寸同步和广播不变 |
| `ipc/web-passwords.ipc.ts` | 密码列表、揭示、保存、填充、提示、禁用站点 | 保留显式明文读取及安全边界 |
| `ipc/browser-workflow.ipc.ts` | 绑定上下文、录制、控制模式、草稿审批、执行控制 | 主窗口限定；不暴露底层 CDP |
| `ipc/working-account.ipc.ts` | 登录、注册、验证码、用户/工作区/会话元数据、反馈、签到 | 认证刷新和状态广播顺序不变 |
| `ipc/working-payment.ipc.ts` | 订单、套餐、购买、升级、支付检查与取消 | 标识校验及账号归属不变 |
| `ipc/working-models.ipc.ts` | 模型目录、保存和连接测试 | VIP/owner 判定不变 |
| `ipc/runtime.ipc.ts` | 应用信息、运行时重初始化、环境检查、功能模块、代理 | 不触发额外安装或更新 |
| `ipc/git.ipc.ts` | 状态、diff、新旧内容、还原、Worktree | 所有现有路径检查继续执行 |
| `ipc/system-files.ipc.ts` | 外链、剪贴板、指定应用打开、默认应用与编辑器发现 | 保留平台限制和白名单 |
| `ipc/channels.ipc.ts` | 渠道 CRUD、密钥、连接/额度查询、OAuth | 登录取消及凭据处理不变 |
| `ipc/settings.ipc.ts` | 用户档案、应用设置、同步设置、主题广播、图标、角标、教程 | 同步事件和设置联动不变 |
| `ipc/scratch-pad.ipc.ts` | Scratch Pad 读写、同步保存、导出和图片剪贴板 | beforeunload 同步保存不改成异步 |
| `ipc/agent-sessions.ipc.ts` | 会话 CRUD、标题/模型、置顶/星标/归档、搜索、迁移、分叉、回退 | 持久化和广播顺序不变 |
| `ipc/agent-workspaces.ipc.ts` | 工作区/项目 CRUD、根目录关联与恢复、排序、置顶 | 创建项目与首会话保持原有编排 |
| `ipc/workspace-capabilities.ipc.ts` | MCP 和 Skill 配置、导入/更新/开关、子文件管理 | 复用已有工作区能力服务 |
| `ipc/agent-execution.ipc.ts` | 发消息、中断、排队、后台任务、权限/runtime/Working 模式切换 | 保留会话与运行状态归属 |
| `ipc/agent-interactions.ipc.ts` | 权限答复、AskUser、ExitPlan、待处理请求恢复 | 重复答复、过期请求和审批后的动作不变 |
| `ipc/agent-tools.ipc.ts` | 工具配置、凭据、开关、自定义工具、连接测试 | 不重写工具执行逻辑 |
| `ipc/attachments.ipc.ts` | 附件读写、保存对话框、内置资源/记忆导出 | 保留文件名、导出内容及路径约束 |
| `ipc/attached-paths.ipc.ts` | 会话/工作区附加目录和文件、Worktree 配置 | 多会话共享目录监听不能提前释放 |
| `ipc/agent-files.ipc.ts` | 列目录、删除、打开、重命名、移动、路径类型和搜索 | 保留会话/工作区/附加目录授权 |
| `ipc/file-preview.ipc.ts` | 独立预览窗口、文本读写、PDF/Office/base64 预览、导出 | 继续复用现有预览服务 |
| `ipc/feishu.ipc.ts` | 旧单 Bot 兼容、多 Bot、绑定、扫码注册 | 不合并掉兼容通道 |
| `ipc/dingtalk.ipc.ts` | 旧接口、多 Bot、连接测试、OAuth | 不改变 OAuth 或 Bot 选择规则 |
| `ipc/wechat.ipc.ts` | 配置、扫码、登出、Bridge 状态/启停 | 复用微信 Bridge |
| `ipc/agent-mail.ipc.ts` | 邮箱登录、取消、登出、状态 | 复用邮件服务 |
| `ipc/storage.ipc.ts` | 统计、清理和迁移取消临时目录清理 | 保留删除范围检查 |
| `ipc/migration.ipc.ts` | 导出预览、导入导出、确认和文件对话框 | 不修改包格式和迁移算法 |
| `ipc/window.ipc.ts` | 窗口控制、快速任务和快捷键 | 使用请求来源窗口，保留转发目标 |
| `ipc/voice-dictation.ipc.ts` | 音频、识别、预览提交、权限、窗口及状态上报 | 保留 2 个 on 监听及 sender 检查 |
| `ipc/planning.ipc.ts` | Todo、日历、分组、标签、提醒、启动 Todo Agent | START_TODO_AGENT 的同步临界区不插入 await |
| `ipc/automation.ipc.ts` | 定时任务管理及立即运行 | 保留 NaN/越界等输入校验 |
| `ipc/memory-ingestion.ipc.ts` | 文档解析、网页提取、知识抽取 | 不在这里扩展为 Memory CRUD |
| `ipc/trading.ipc.ts` | 行情/K 线/搜索/自选及终端启停 | 不新增交易指令 |
| `ipc/dsh.ipc.ts` | Cordis 启停/重载、视图、文件和双向事件 | broadcaster 只设置一次 |
| `lib/ipc-file-access.ts` | 原文件路径授权和 Worktree 判断辅助函数 | 不复用到不适用的访问场景 |
| `lib/system-app-info.ts` | 默认应用查询、图标缓存、编辑器发现辅助 | Windows/macOS 分支分别验证 |
| `lib/windows-default-app.ts` | 注册表查询、命令解析、环境变量展开 | 扩展名/ProgId 校验不能丢失 |
| `lib/app-icon-path.ts` | resolveAppIconPath | 原 ipc.ts re-export |
| `lib/attached-path-lifecycle.ts` | releaseDirectoryWatcherIfUnreferenced | 不缓存可能过期的引用状态 |
| `app/ipc-startup-maintenance.ts` | 自动归档、周期任务、失效附加路径与临时数据清理 | 调用次数和启动相对顺序不变 |

`ipc.ts` 预计保留 100–250 行：导入、日志、依序调用注册器、原位调用 updater 与启动维护。不设置机械文件数量目标；接近 600 行的域优先再按完整行为拆分。

## 3. 依赖与接口规则

方向保持为：`ipc.ts → ipc/*.ipc.ts → lib/*`。子注册器不能反向导入 ipc.ts；确需主窗口时保留原延迟获取方式。

```ts
// ipc/web-tabs.ipc.ts
import { ipcMain } from 'electron'
import { WEB_IPC_CHANNELS } from '@copis/shared'
import { listWebTabs } from '../lib/web-tab-manager'

export function registerWebTabsIpcHandlers(): void {
  ipcMain.handle(WEB_IPC_CHANNELS.LIST, () => listWebTabs())
  // 实施时将其余同域处理器逐个原样迁入，并删除旧注册。
}
```

上例只展示注册形式，不能作为整个域已完成的实现。不建立巨型 IpcContext，不提供任意 service 查找器，不使用 any。

共享 helper 只有被多个域实际调用才外移；只属于一个域的参数解析和校验放在本域。`assertBrowserWorkflowMainWindow` 留在 workflow 域，Working 模型访问判定留在 models 域。

## 4. T0：建立迁移前契约基线

新增测试目录 `apps/electron/src/main/ipc-tests/`，与生产注册器分开。测试 helper 和各测试文件均不超过 600 行。

- [ ] 保存当前 Git 状态，核对 ipc.ts 是否有并行改动；不还原用户修改。
- [ ] 新建 `ipc-tests/registration-inventory.test.ts` 与分域 fixture。使用已有 TypeScript AST API 遍历 ipc.ts 的 handle/on 调用，记录通道表达式、注册类型和源顺序；保留迁移前 fixture，不能每次测试自动重新生成预期值。
- [ ] fixture 特别记录直接字符串通道（例如 migration:*）、5 个 on，以及 updater 的独立注册调用。
- [ ] 后续扫描范围扩到 ipc/*.ipc.ts，并分别检查唯一性和集合一致。静态注册点计数不能替代运行测试。
- [ ] 为每个迁移域新增 `ipc-tests/<domain>.test.ts`：mock Electron 边界和对应服务，实际调用新注册函数、取出 handler 并执行；验证服务参数、返回/异常、广播与同步返回值。
- [ ] 先为现有高风险行为建立通过的特征测试；新增注册函数测试在迁移实现前应因函数尚不存在而失败，再迁移使其通过。

现有 `lib/web-tab-ipc-contract.test.ts` 只检查 REORDER 字符串；`ipc-workspace-search.test.ts` 直接测试搜索服务。两者都不能证明 IPC 完整注册或正确转发，不将它们当作 T0 的替代品。

用于首个域的最小行为测试示例（写入 `ipc-tests/web-tabs.test.ts`，每文件独立 Bun 进程）：

```ts
import { expect, mock, test } from 'bun:test'
import { WEB_IPC_CHANNELS } from '@copis/shared'

const handle = mock(() => {})
const snapshot = { tabs: [], activeTabId: null }
const list = mock(() => snapshot)

mock.module('electron', () => ({ ipcMain: { handle } }))
mock.module('../lib/web-tab-manager', () => ({ listWebTabs: list }))

test('Given 页签列表请求 When 调用注册的 handler Then 返回服务快照', async () => {
  const { registerWebTabsIpcHandlers } = await import('../ipc/web-tabs.ipc')
  registerWebTabsIpcHandlers()
  const registration = handle.mock.calls.find(
    (args: unknown[]) => args[0] === WEB_IPC_CHANNELS.LIST,
  ) as unknown[] | undefined
  expect(registration).toBeDefined()
  const handler = registration?.[1] as (() => unknown)
  expect(handler()).toEqual(snapshot)
  expect(list).toHaveBeenCalledTimes(1)
})
```

该示例覆盖第一个 LIST 搬移步骤；继续添加同域处理器时需补全对应服务 mock。验证重复通道、参数和广播时另写行为场景，不依赖这个单一测试覆盖整个域。

## 5. T1–T7：分批迁移

每个域均执行“增加新边界测试 → 运行确认失败原因 → 原样迁移 → 删除旧注册 → 在原逻辑位置调用新注册器 → 测试和构建”。迁移阶段保留当前相对顺序，最后聚合文件不为美观随意排序。

| 任务 | 迁移顺序 | 必须覆盖的 BDD 场景 |
|---|---|---|
| T1 浏览器 | web-tabs → bookmarks → passwords → workflow | Given 有效/无效 sender，When 调用工作流，Then 只允许原主窗口；收藏广播、页签尺寸和凭据揭示保持一致 |
| T2 账号与系统 | Working account/payment/models → channels → runtime/settings/scratch-pad → window/voice | Given 同步设置或 Scratch Pad 保存，When sendSync，Then returnValue 与原实现一致；Given OAuth 取消，Then 当前授权流程终止；语音上报仅接受原允许的 sender |
| T3 文件与 Git | 先 file-access/platform helpers → git/system-files → attachments/attached-paths → agent-files/file-preview | Given 越界路径或符号链接，When 读写，Then 保持拒绝；Given 多会话共享目录，When 移除一个引用，Then 不停掉其他会话监听 |
| T4 Agent | sessions → workspaces → capabilities → execution/interactions/tools | Given 执行中会话，When 中断/切模式/权限答复，Then 行为、run/session 归属和广播不变；Given 删除工作区，Then 原取消与清理顺序保留 |
| T5 外部集成 | feishu → dingtalk → wechat → agent-mail → trading → dsh | Given 旧单 Bot API，When 调用，Then 仍映射到原约定对象；Given DSH 事件，Then 转发至原窗口集合且跳过已销毁窗口 |
| T6 计划与数据 | planning → automation → memory-ingestion → storage → migration | Given Todo 启动，When 同步处理，Then 关联与创建不会因新增 await 发生竞态；Given 非法定时参数，Then 不写入配置；导入取消只清理原允许范围 |
| T7 启动收口 | 提取启动维护 → 保留 updater 调用 → 清理旧 helper/import → 复核全部通道 | Given 应用正常启动一次，Then 归档定时器仅建立一次、启动清理各调用一次；注册器 import 本身不启动定时任务 |

- [ ] T1 完成；可独立提交和验证。
- [ ] T2 完成；同步 on 和异步 handle 均验证。
- [ ] T3 完成；Windows 与 macOS 分支分别验证，非当前平台真实集成记录待测。
- [ ] T4 完成；会话、权限和目录监听回归通过。
- [ ] T5 完成；兼容 API、事件与登录清理回归通过。
- [ ] T6 完成；输入校验、文件副作用与同步临界区回归通过。
- [ ] T7 完成；新旧源码达标并保留全部对外入口。

## 6. 启动副作用迁移细则

不能简单将整个 registerIpcHandlers 内容按注释段落搬走。当前函数除了注册，还执行主题订阅、自动归档、定时器、失效路径清理、临时文件清理和 DSH broadcaster 设置。

- [ ] 将自动归档和清理提取为 `startIpcStartupMaintenance(): void`，继续从原调用位置执行；函数导入时无副作用。
- [ ] 用 fake timer 和 mock 服务验证立即归档、24 小时周期、清理开关及异常不中断启动。测试提供清理定时器的受控边界；不在真实用户配置上测试。
- [ ] 主题订阅随 settings 域，DSH broadcaster 随 dsh 域；在实际入口只调用一次。不要以静默忽略重复注册掩盖调用错误。
- [ ] 不顺便改变应用关闭清理策略；如发现原有泄漏，记录为独立修复而非夹入行为保持迁移。

## 7. 验证命令

在仓库根目录执行。测试独立进程运行，避免 Bun module mock 污染。

```bash
# T0 建好并在各任务新增测试后执行
for file in apps/electron/src/main/ipc-tests/*.test.ts; do
  bun test "$file" || exit 1
done

bun run typecheck
bun run --filter='@copis/electron' build:main
bun run --filter='@copis/electron' build:preload
bun run --filter='@copis/electron' build:renderer

# T1 必须追加
bun test apps/electron/src/main/lib/web-bookmark-service.test.ts
bun test apps/electron/src/main/lib/web-tab-session-service.test.ts
bun test apps/electron/src/main/lib/web-tab-manager.test.ts
bun test apps/electron/src/main/lib/web-tab-ipc-contract.test.ts

# T3 必须追加
bun test apps/electron/src/main/ipc-workspace-search.test.ts

# 全部任务完成后，使用仓库隔离测试入口
bun run test
git diff --check
```

DSH preload 虽不拆分，T5 仍补 `bun run --filter='@copis/electron' build:dsh-bridge-preload`；JS prompt 链路补 `build:web-javascript-prompt-preload`。类型检查或构建失败先区分本批变更与已有工作区问题，不能声称未通过的检查成功。

行数检查至少覆盖 ipc.ts、ipc/ 下所有新文件及新增 helper/测试；建议使用全仓扫描清单中的命令重新扫描。静态注册集合必须保持 376 handle / 5 on 的迁移前基线，若同期业务确有新增则单独审查其增量，不为过测试直接更新 fixture。

## 8. 最终验收与交付

- [ ] ipc.ts 与所有新增手写源文件 ≤600 行；入口、注册器、平台逻辑和启动维护各自职责清晰。
- [ ] 注册清单无丢失/重复，原导出和 preload 方法兼容；代表性运行测试覆盖参数、返回、错误、事件和取消/同步行为。
- [ ] 自动化检查通过；失败、跳过和平台限制如实记录。
- [ ] 用户在 Electron 实际窗口确认：普通 HTTP(S) 网页、收藏夹/密码提示、Agent 发送/权限/会话切换、文件预览、设置保存、语音及本批涉及的外部集成。
- [ ] 代码简化复核按 AGENTS.md 执行 code-simplifier；环境不可用时明确说明，人工检查循环依赖、重复状态、过度抽象及组件职责。
- [ ] 分批提交时仅纳入本次代码和必要版本变化，不包含他人改动；不触发部署。
- [ ] 回写总计划中的完成状态时保留历史扫描值和新验证记录。自动化完成与用户 UI 待确认分别标注。

本次交付是计划文档；上述复选框全部保持未完成，不能据文档生成推断实际拆分或测试已经完成。
