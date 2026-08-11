# Working Payment Default Pi Workspace Bootstrap Implementation Plan

**状态：已完成。** 固定 `default` 项目环境注入及其拒绝场景已实现并通过定向测试；后续本机 Pi capability 工作在独立实现中完成，不改变本计划的运行时环境契约。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Rust HTTP API 在每次启动时获得唯一、已规范化的 Copis 默认项目路径，为后续设置页支付 Pi Worker 固定工作区提供可信运行时输入。

**Architecture:** Electron 主进程是默认项目配置的唯一来源：它调用 `ensureDefaultWorkspace()`，验证 `slug === "default"`、项目根和 `projectPath` 的真实目录关系，然后仅通过 Rust 子进程环境传递固定工作区。Rust 本阶段只接收环境契约，尚不创建支付订单、不启动支付 Pi Worker，也不调用 `edu-api`。

**Tech Stack:** Electron 主进程、TypeScript、Bun test、Rust HTTP API 子进程环境。

---

## Runtime Contract

Rust 子进程启动环境必须包含以下四项，且它们不来自 Renderer、IPC 参数、订单数据或普通 Agent session：

```text
COPIS_PAYMENT_WORKSPACE_SLUG=default
COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT=<defaultWorkspace.projectRootPath 的真实路径>
COPIS_PAYMENT_WORKSPACE_CWD=<defaultWorkspace.projectPath 的真实路径>
COPIS_PAYMENT_HOME_ROOT=<projectRoot>/.copis/payment
```

`projectPath` 必须是 `projectRootPath` 的严格子目录。默认项目缺失、路径不存在、含符号链接逃逸、slug 不是 `default` 或路径关系不合法时，Rust 进程不得启动；不得回退到任意工作区、当前目录、用户目录或调用方提供路径。

### Task 1: 注入固定默认项目运行时环境

**Files:**
- Modify: `apps/electron/src/main/lib/http-api-server.ts`
- Modify: `apps/electron/src/main/lib/http-api-server-runtime.test.ts`

- [x] **Step 1: 写入失败的启动环境测试**

在 `http-api-server-runtime.test.ts` 从 `node:fs` 补充导入 `mkdirSync`，新增测试。测试创建存在的 `<root>/default-workspace/project` 目录后，使用 `startHttpApiServer()` 的测试专用 `paymentWorkspace` 选项启动 fake Rust 子进程。断言子进程环境包含四个环境变量，且值完全等于规范化路径：

```ts
test('Given 默认支付项目 When 启动 Rust API Then 注入固定 Pi 工作区环境', () => {
  const root = createRoot()
  const projectRootPath = join(root, 'default-workspace')
  const projectPath = join(projectRootPath, 'project')
  mkdirSync(projectPath, { recursive: true })
  const records: SpawnRecord[] = []

  startHttpApiServer({
    rootDir: join(root, 'modules'),
    paymentWorkspace: { slug: 'default', projectRootPath, projectPath },
    spawnImpl: spawnFixture(records),
  })

  expect(records[0]?.options.env).toMatchObject({
    COPIS_PAYMENT_WORKSPACE_SLUG: 'default',
    COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: realpathSync(projectRootPath),
    COPIS_PAYMENT_WORKSPACE_CWD: realpathSync(projectPath),
    COPIS_PAYMENT_HOME_ROOT: join(realpathSync(projectRootPath), '.copis', 'payment'),
  })
})
```

同一测试文件增加拒绝场景，验证非默认 slug 不会启动 Rust 子进程：

```ts
test('Given 非默认支付项目 When 启动 Rust API Then 拒绝启动子进程', () => {
  const root = createRoot()
  const projectRootPath = join(root, 'other-workspace')
  const projectPath = join(projectRootPath, 'project')
  mkdirSync(projectPath, { recursive: true })
  const records: SpawnRecord[] = []

  startHttpApiServer({
    rootDir: join(root, 'modules'),
    paymentWorkspace: { slug: 'other', projectRootPath, projectPath },
    spawnImpl: spawnFixture(records),
  })

  expect(records).toHaveLength(0)
})
```

- [x] **Step 2: 运行测试并确认失败原因是环境变量尚未注入**

Run:

```bash
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
```

Expected: FAIL，新增断言缺少 `COPIS_PAYMENT_WORKSPACE_*`，并且非 `default` 项目错误地仍会启动 fake Rust 子进程；不能因 fake Rust binary、端口或模块安装失败而失败。

- [x] **Step 3: 实现默认项目解析和环境注入**

在 `http-api-server.ts`：

1. 从 `agent-workspace-manager.ts` 导入 `ensureDefaultWorkspace`，从 `@copis/shared` 导入 `AgentWorkspace` 类型；从 `node:fs` 导入 `realpathSync`，从 `node:path` 导入 `isAbsolute`、`relative` 和 `sep`。
2. 为测试增加非 Renderer 可达的 `paymentWorkspace?: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>` 启动选项；生产调用没有该选项时只使用 `ensureDefaultWorkspace()`。
3. 新增导出的纯边界函数 `resolvePaymentWorkspaceRuntime(workspace)`：拒绝非 `default` slug、空路径、无法 `realpathSync` 的路径、`projectPath` 等于根目录、以及 `relative(root, project)` 为空、以 `..` 开头或为绝对路径的情形；成功后返回上述四项字符串。
4. 在 `spawnManagedProcess()` 构建 `env` 前调用该函数，并把返回结果展开到 Rust 环境。解析失败必须在现有 `spawnManagedProcess()` 错误路径中阻止子进程启动。

实现的关键形状如下：

```ts
export interface PaymentWorkspaceRuntime {
  COPIS_PAYMENT_WORKSPACE_SLUG: 'default'
  COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: string
  COPIS_PAYMENT_WORKSPACE_CWD: string
  COPIS_PAYMENT_HOME_ROOT: string
}

export function resolvePaymentWorkspaceRuntime(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath' | 'projectPath'>,
): PaymentWorkspaceRuntime {
  if (workspace.slug !== 'default' || !workspace.projectRootPath || !workspace.projectPath) {
    throw new Error('默认支付项目配置不完整')
  }
  const projectRootPath = realpathSync(resolve(workspace.projectRootPath))
  const projectPath = realpathSync(resolve(workspace.projectPath))
  const relation = relative(projectRootPath, projectPath)
  if (!relation || relation.startsWith(`..${sep}`) || relation === '..' || isAbsolute(relation)) {
    throw new Error('默认支付项目路径不在项目根目录内')
  }
  return {
    COPIS_PAYMENT_WORKSPACE_SLUG: 'default',
    COPIS_PAYMENT_WORKSPACE_PROJECT_ROOT: projectRootPath,
    COPIS_PAYMENT_WORKSPACE_CWD: projectPath,
    COPIS_PAYMENT_HOME_ROOT: join(projectRootPath, '.copis', 'payment'),
  }
}
```

- [x] **Step 4: 运行定向测试确认通过**

Run:

```bash
bun test apps/electron/src/main/lib/http-api-server-runtime.test.ts
```

Expected: PASS，既有 Pi Worker 可执行文件与开发脚本运行时环境测试仍通过。

- [x] **Step 5: 运行受影响构建检查并检查 diff**

Run:

```bash
bun run --filter='@copis/electron' build:main
git diff --check
```

Expected: 两条命令退出码为 `0`，且未改动支付 UI、Rust 路由、`edu-api` 调用或包版本。

## Plan Self-Review

- Spec coverage: Task 1 将固定默认项目从 Electron 注入 Rust。Rust 支付协调器、Pi Worker 调度和 `edu-api` prepare/finalize 属于下一阶段，避免在未冻结服务端契约下构造支付调用。
- Placeholder scan: 无 `TODO`、`TBD` 或未命名测试命令。
- Type consistency: `PaymentWorkspaceRuntime` 和四个 Rust 子进程环境变量使用同一 slug/root/cwd/PiHome 契约。
