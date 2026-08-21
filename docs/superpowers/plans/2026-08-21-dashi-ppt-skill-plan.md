# Dashi PPT 内置 Skill 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 参考 ai-education 对 Dashi PPT 的上游锁定、补丁合并和运行时复用方式，将 Dashi PPT 作为 Copis 的内置 Skill；只增加 Skill 同步、Copis 适配和受限命令入口，复用 Copis 已有的 Node.js runtime、`node_modules`、Playwright Core 和 Chromium headless shell，不新增一套 Dashi 功能模块。

**Architecture:** Dashi 上游源码通过 Git submodule 固定 commit，再由同步脚本应用 Copis 本地 patch，生成 `apps/electron/default-skills/dashi-ppt`。Skill 文档和轻量资源沿用现有 `default-skills` 生命周期注入工作区。执行时由 Copis 的 Dashi runtime adapter 解析已有的 Node.js、共享 `node_modules`、Playwright Core 和 Chromium headless shell，使用受限的 `copis dashi-ppt` 命令桥接调用 Dashi 脚本。运行时依赖的下载、校验、激活、版本升级和浏览器准备全部继续由现有功能模块链路负责。

**Tech Stack:** Git submodule、Bash 同步脚本、TypeScript/Bun、已有 Node.js runtime、已有共享 `node_modules`、已有 Playwright Core、已有 Chromium headless shell、Electron 主进程、Rust HTTP API 命令权限策略、Pi Agent Skill loader、现有编译版 Copis CLI。

## 关键修正

本计划不再引入以下内容：

- 不新增 `dashi-ppt` 功能模块名称。
- 不新增 `scripts/build-dashi-ppt-module.ts`。
- 不为 Dashi 重新执行 `npm ci`、`npm install` 或 `playwright install`。
- 不新增 Dashi COS manifest artifact、版本锁、下载地址、部署参数或设置页模块行。
- 不把 Node.js、`node_modules`、Playwright Core 或 Chromium headless shell 再复制进 Skill、Electron 资源或新的 tar.gz。
- 不重启 HTTP API 来激活 Dashi 专属模块；Dashi 只消费应用启动时已经准备好的既有 runtime。

Dashi 只新增一个**运行时适配层**，负责把现有能力转换成 Dashi 所需的环境变量和命令参数。它不是功能模块，不拥有独立版本、缓存、active 文件或 COS 生命周期。

## Global Constraints

- 上游基线优先复用 ai-education 生成目录当前记录的 commit `1c721226ae04af6cb72599b9d99c540734726d6b`，上游 Skill 版本为 `0.4.2`；实施 Task 1 必须先验证该 commit 仍可从上游获取。若上游已清理或重写该 commit，不得静默替换，必须先比较 ai-education 当前 submodule HEAD `2eee97e5a58cfc54fd0ca66b582251153710f64f` 与生成目录的差异，再批准一个可获取的固定 commit 并同步更新 `UPSTREAM.md`、patch 基线和版本审计记录；构建和发布不得直接跟随未锁定的 `main`。
- 首次 Copis 本地集成会把内置 Skill 版本定为 `0.4.3`；上游版本记录在 `UPSTREAM.md`，上游内容或本地 patch 发生变化时递增 Skill patch 版本。
- Node.js、共享 `node_modules`、Playwright Core 和 Chromium headless shell 的版本与安装路径不在 Dashi 计划中重新定义；实现必须调用现有 owner/resolver，不能复制一套路径搜索和安装逻辑。
- Dashi 不依赖用户系统安装的 Node.js、npm、Chrome 或 Python。运行环境必须来自 Copis 已激活的既有 runtime。
- Dashi CLI 的用户输入路径必须解析到当前 Agent 工作区允许写入的目录；不能写入功能模块目录、其他工作区或系统目录。
- Rust HTTP API 仍是 Agent 文件读写和项目命令的权限执行方；新增 Dashi 命令只允许固定子命令和结构化参数，不开放任意 shell、管道、重定向或任意 Node 脚本执行。
- PPT 视觉生成由 `dashi-ppt` 负责；已有 `.pptx` 的读取、检查和结构化编辑仍由 `officecli` 负责。旧 `pptx` 与 `guizang-ppt-skill` 继续保持退役，不恢复为独立默认 Skill。
- 保留上游 `AGPL-3.0-only` LICENSE、Skill 内的 NOTICE 和依赖许可证信息；不得把上游文件改成 Copis 自有版权声明。
- 所有新增注释和日志优先使用中文；TypeScript 禁止 `any`，类型导入使用 `import type`，对象结构使用 `interface`。
- 修改任何 `default-skills/<skill>/` 内容都必须同步递增该 Skill frontmatter 的 `version`；受影响的 `@copis/electron` patch 版本和 `bun.lock` 必须同步更新。
- 不修改 `README.md` 或 `AGENTS.md`，除非先得到用户明确允许；实现合入前需单独确认这两个文件是否同步更新。
- Electron UI 的最终视觉和真实交互由用户在实际应用窗口中确认；Agent 只执行代码、类型、构建、运行状态和自动化测试验证，不用截图替代用户验收。

## Existing Runtime Reuse Contract

Dashi runtime adapter必须只组合现有能力，目标接口如下：

```ts
export interface DashiPptRuntime {
  nodeExecutable: string
  nodeModulesRoot: string
  playwrightCoreEntrypoint: string
  chromiumHeadlessShell: string
  skillProjectRoot: string
}

export interface ResolveDashiPptRuntimeOptions {
  workspaceRoot: string
  skillRoot?: string
  nodeExecutable?: string
  nodeModulesRoot?: string
  playwrightCoreEntrypoint?: string
  chromiumHeadlessShell?: string
}

export function resolveDashiPptRuntime(
  options: ResolveDashiPptRuntimeOptions,
): DashiPptRuntime
```

解析规则：

- `nodeExecutable` 复用 `getFunctionalModulePath('node-runtime')`，与 Browser Workflow 当前的 `resolveNodeRuntimeEntrypoint()` 使用同一入口。
- `playwrightCoreEntrypoint` 复用 `resolvePlaywrightCoreEntrypoint()`，不在 Dashi 代码中重新解析功能模块目录。
- `chromiumHeadlessShell` 复用现有 Chromium headless shell resolver 和已准备的浏览器缓存路径。Dashi 的 `chrome-path.mjs` 只能优先读取 Copis 注入的绝对路径，不能自行下载浏览器或回退到用户系统 Chrome。
- `nodeModulesRoot` 复用 Copis 已有的共享 `node_modules` 运行时根目录；Dashi 项目自身的 `package.json` 和 `package-lock.json` 只作为上游来源和依赖契约，不在每个工作区或新功能模块中重新安装依赖。
- `skillProjectRoot` 指向当前有效的 Dashi 项目源码；运行时不能把输出写入该目录，只能把输出写入调用方工作区。
- 如果当前分支中的既有 headless shell resolver 名称与上游 Dashi 的 `resolveHeadlessShellPath()` 不同，适配层应调用现有 owner 的等价接口；不要在 Dashi Skill 中新增第二套浏览器发现逻辑。

当前仓库可见的 `scripts/build-playwright-core-module.ts` 注释仍描述 Playwright Core 归档“不含浏览器二进制”，但用户确认 Copis 已有 Chromium headless shell。实现 Task 3 必须先以实际激活模块和现有 runtime resolver 验证 shell 的来源；不修改 `build-playwright-core-module.ts` 去重复打包浏览器。如果当前 checkout 缺少 resolver，只补齐既有浏览器 runtime owner 的解析接口，不新增 Dashi artifact 或下载流程。

## File Map

### Upstream and generated Skill

- Create: `.gitmodules` entry for `third_party/dashi-ppt-skill`.
- Create: `third_party/dashi-ppt-skill` pinned submodule pointer.
- Create: `patches/dashi-ppt/local-customizations.patch`.
- Create: `apps/electron/scripts/sync-dashi-ppt-skill.sh`.
- Create: `apps/electron/scripts/test-dashi-ppt-sync.sh`.
- Generate: `apps/electron/default-skills/dashi-ppt/**` from the pinned submodule plus the local patch.
- Modify through the local patch: `apps/electron/default-skills/dashi-ppt/SKILL.md`, Skill-local `README.md`, `UPSTREAM.md`, Dashi path/runtime instructions, and the Dashi browser path adapter.

### Runtime adapter and command bridge

- Create: `apps/electron/src/main/lib/dashi-ppt-runtime.ts`.
- Create: `apps/electron/src/main/lib/dashi-ppt-runtime.test.ts`.
- Create or modify the existing Copis CLI dispatch source used by `apps/electron/scripts/compiled-runtime-entry.ts` to support `copis dashi-ppt`.
- Modify: `apps/electron/src/main/lib/agent-runtime-env.ts` only to pass the existing Dashi runtime environment, without adding a functional-module path.
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts` or the existing Agent runtime builder to include the Dashi runtime variables.
- Modify: `native/http-api-server/src/agent_files.rs` and its separate tests for the narrow `copis dashi-ppt` command policy.
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` only if the existing command bridge requires a typed Agent tool registration; do not add a second general shell tool.

### Skill routing and workspace lifecycle

- Modify: `apps/electron/default-skills/officecli/SKILL.md` through a direct focused edit; bump its version from `1.0.146` to `1.0.147`.
- Modify: `apps/electron/default-skills/find-skills/references/office-efficiency.md`; bump `find-skills/SKILL.md` from `1.0.4` to `1.0.5`.
- Modify: `apps/electron/src/main/lib/default-skills-manifest.test.ts`.
- Modify: `apps/electron/src/main/lib/config-paths.test.ts` only to preserve assertions that `pptx` and `guizang-ppt-skill` are retired and `dashi-ppt` is not retired.
- Modify: `apps/electron/src/main/lib/agent-workspace-manager.test.ts` for default injection, version upgrade, and runtime directory filtering.

### Version and packaging

- Modify: root `package.json` only if `sync:dashi-ppt`, `check:dashi-ppt`, and `test:dashi-ppt-sync` scripts are not already present.
- Modify: `apps/electron/package.json` patch version `0.0.64` to `0.0.65` after implementation is complete.
- Modify synchronized `bun.lock` workspace metadata.
- Verify: `apps/electron/electron-builder.yml` continues to package the generated default Skill.
- Do not modify: `scripts/build-functional-module-manifest.ts`, `scripts/publish-functional-modules.ts`, `scripts/functional-module-version-lock.ts`, `scripts/functional-module-versions.json`, `deploy.sh`, `deploy.ps1`, `FunctionalModulesCard.tsx`, or functional-module definitions for Dashi.
- Do not modify: root `README.md` or `AGENTS.md` without explicit user permission.

---

### Task 1: Lock, Synchronize, and Audit the Upstream Skill

**Files:**
- Create: `.gitmodules` submodule entry.
- Create: `third_party/dashi-ppt-skill` pinned commit.
- Create: `patches/dashi-ppt/local-customizations.patch`.
- Create: `apps/electron/scripts/sync-dashi-ppt-skill.sh`.
- Create: `apps/electron/scripts/test-dashi-ppt-sync.sh`.
- Generate: `apps/electron/default-skills/dashi-ppt/**`.

**Interfaces:**
- Consumes: `third_party/dashi-ppt-skill/skills/dashi-ppt`, the pinned upstream commit, and the local patch.
- Produces: A reproducible generated directory at `apps/electron/default-skills/dashi-ppt` and `UPSTREAM.md` containing repository URL, commit, upstream Skill version, and local patch reference.

- [ ] **Step 1: Add the pinned submodule and verify the reference baseline.**

  Add the submodule at `third_party/dashi-ppt-skill` with URL `https://github.com/chuspeeism/dashi-ppt-skill.git`, shallow history, and branch metadata matching ai-education. First verify whether commit `1c721226ae04af6cb72599b9d99c540734726d6b` is still reachable. ai-education’s generated `UPSTREAM.md` records that commit, while its currently checked-out submodule is `2eee97e5a58cfc54fd0ca66b582251153710f64f` and the local clone cannot resolve the older object. If the recorded commit is unreachable, compare the two baselines and approve one reachable fixed commit before generating Copis files. The final submodule pointer and `UPSTREAM.md` must name the same reachable commit.

- [ ] **Step 2: Define the local patch as the only source of Copis-specific Skill changes.**

  The patch must add Copis frontmatter:

  ```yaml
  displayName: Dashi PPT
  group: 系统内置
  version: "0.4.3"
  license: AGPL-3.0-only
  ```

  It must adapt the Skill to Copis without embedding a new dependency runtime:

  - use `copis dashi-ppt` commands or the existing typed Dashi tool bridge rather than `npm --prefix`, direct system `node`, `npx`, or a system HTTP server;
  - write `goal.json`, generated HTML, assets, and exports below the current workspace project/output directory;
  - use the existing Copis Node.js runtime and Playwright/Chromium runtime injected by the bridge;
  - keep the 12 theme rules, layout uniqueness, `validate:goal-spec`, `validate:swiss`, and `validate:goal-copy` checks;
  - preserve the upstream AGPL license and attribution files;
  - remove ai-education-only `workspace_mode`, `working_share`, and manual dependency-install instructions.

- [ ] **Step 3: Implement the sync script with ai-education’s failure semantics.**

  `apps/electron/scripts/sync-dashi-ppt-skill.sh` must accept only `--write` and `--check`, and must support these environment overrides for isolated tests:

  ```text
  DASHI_PPT_UPSTREAM_ROOT
  DASHI_PPT_DESTINATION
  DASHI_PPT_PATCH
  ```

  `--write` must copy to temporary staging, apply the patch with `git apply --check` before applying it, copy upstream LICENSE and NOTICE, write `UPSTREAM.md`, validate frontmatter, then replace the destination atomically with a backup fallback. `--check` must compare the staged result with the destination using `diff -qr`. A dirty destination must fail before replacement; a patch conflict must leave the old destination untouched.

  The sync script must not run `npm ci`, `npm install`, `npx playwright install`, or any browser download. Dependency and browser ownership remains outside the Skill sync path.

- [ ] **Step 4: Add fixture tests before using the real upstream copy.**

  The shell test fixture must cover:

  ```text
  missing upstream -> non-zero exit and “上游子模块未初始化”
  write then check -> pass and preserve LICENSE/version/commit metadata
  modified destination -> --check fails with drift error
  patch conflict -> non-zero exit and sentinel destination remains unchanged
  destination inside a Git worktree -> patch still applies
  no runtime directory copied -> node_modules/browser cache/output are absent from generated Skill
  ```

- [ ] **Step 5: Generate the initial merged copy and run the reproducibility check.**

  Run:

  ```bash
  bash apps/electron/scripts/sync-dashi-ppt-skill.sh --write
  bash apps/electron/scripts/sync-dashi-ppt-skill.sh --check
  bash apps/electron/scripts/test-dashi-ppt-sync.sh
  ```

  The generated copy may contain Dashi source, prebuilt `dist` assets, theme images, package metadata, and license files. It must not contain `node_modules`, `.playwright-browsers`, `output`, `screens`, `uploads`, or machine-specific runtime state.

- [ ] **Step 6: Audit upstream and package licenses.**

  Preserve the upstream `LICENSE` and `NOTICE`, enumerate the locked packages declared by Dashi’s `project/package-lock.json`, and record the dependency notice without installing a second copy into Copis. Reject the integration if required attribution is missing.

- [ ] **Step 7: Run the independent test cycle and commit the sync boundary.**

  Run the two shell tests above and review `git diff --stat` for generated files. Commit the submodule pointer, patch, sync scripts, and generated Skill as one recoverable change.

### Task 2: Add the Built-in Skill and Resolve PPT Routing

**Files:**
- Modify through patch: `apps/electron/default-skills/dashi-ppt/SKILL.md` and its references.
- Modify: `apps/electron/default-skills/officecli/SKILL.md` to version `1.0.147`.
- Modify: `apps/electron/default-skills/find-skills/references/office-efficiency.md`.
- Modify: `apps/electron/default-skills/find-skills/SKILL.md` to version `1.0.5`.
- Modify: `apps/electron/src/main/lib/default-skills-manifest.test.ts`.

**Interfaces:**
- Consumes: The generated `dashi-ppt` directory from Task 1 and existing runtime bridge commands.
- Produces: A first-party Skill automatically copied to new and existing workspaces, with deterministic routing between visual deck creation and existing Office document editing.

- [ ] **Step 1: Define Dashi’s trigger and routing contract in `SKILL.md`.**

  The description must trigger for “制作 PPT、演示文稿、幻灯片、汇报材料、HTML presentation、PPTX export” when the user wants a visual presentation generated. It must explicitly route:

  ```text
  新建视觉演示、需要主题布局、默认 HTML 或导出 PPTX -> dashi-ppt
  读取/检查/修改已有 DOCX/XLSX/PPTX 的 OOXML 结构 -> officecli
  修改已有 PPTX 的文本、表格、形状、批量属性 -> officecli
  ```

  `dashi-ppt` must not claim to replace `officecli` for arbitrary existing `.pptx` editing.

- [ ] **Step 2: Replace ai-education-only delivery text with Copis delivery text.**

  Use this Copis contract:

  ```text
  输出目录：当前工作区的 project/output/<deck-name>/
  HTML：通过 Copis 内置浏览器打开本地预览地址
  PPTX/PDF：只在用户明确要求对应格式时导出到当前工作区
  预览服务：通过现有 Dashi runtime bridge 启动，不能用 python -m http.server 或 npx serve
  依赖：由 Copis 既有 runtime 提供，Skill 不执行 npm install
  ```

  Keep the upstream theme-selection, goal JSON, media staging, layout inspection, validation, and two-round repair rules.

- [ ] **Step 3: Update OfficeCLI’s PowerPoint section without restoring the retired `pptx` Skill.**

  Replace the current “load the `pptx` specialized Skill” guidance with the explicit split above. Keep `officecli` aliases `ppt` and `powerpoint` for CLI format arguments, but do not reference a bundled `pptx/SKILL.md` that no longer exists.

- [ ] **Step 4: Update the Skill discovery office reference.**

  Change `find-skills/references/office-efficiency.md` so its PPT generation row points to `dashi-ppt`, while the Office document row points to `officecli`. Bump `find-skills` to `1.0.5` because its bundled reference content changes.

- [ ] **Step 5: Add manifest and routing regression tests.**

  Extend `default-skills-manifest.test.ts` with assertions that:

  ```ts
  bundled.has('dashi-ppt') === true
  readFrontmatter('dashi-ppt').get('displayName') === 'Dashi PPT'
  readFrontmatter('dashi-ppt').get('group') === '系统内置'
  readFrontmatter('dashi-ppt').get('version') === '0.4.3'
  dashiContent.includes('copis dashi-ppt')
  officeContent.includes('officecli')
  officeContent does not reference a bundled pptx/SKILL.md
  ```

  Assert that `pptx` and `guizang-ppt-skill` remain absent from bundled default Skills and remain listed as retired slugs.

- [ ] **Step 6: Run the Skill manifest tests and commit the routing boundary.**

  ```bash
  bun test apps/electron/src/main/lib/default-skills-manifest.test.ts
  bun test apps/electron/src/main/lib/config-paths.test.ts
  ```

### Task 3: Build the Thin Runtime Adapter on Existing Copis Modules

**Files:**
- Create: `apps/electron/src/main/lib/dashi-ppt-runtime.ts`.
- Create: `apps/electron/src/main/lib/dashi-ppt-runtime.test.ts`.
- Reuse: `apps/electron/src/main/lib/playwright-core-runtime.ts` and its tests.
- Reuse: existing Node runtime resolver used by `browser-workflow-runner.ts`.
- Reuse: existing Chromium headless shell resolver and browser cache owner.
- Modify only existing runtime owner files if the resolver needs to expose a typed path.

**Interfaces:**
- Consumes: active `node-runtime`, active `playwright-core`, existing shared `node_modules`, existing Chromium headless shell, and the generated Dashi project.
- Produces: A typed runtime object and sanitized environment for the Dashi bridge. It does not create a module archive, active file, cache entry, COS artifact, or installation UI.

- [ ] **Step 1: Inventory the existing runtime paths before adding code.**

  Verify on a real installed environment:

  ```text
  getFunctionalModulePath('node-runtime') -> executable Node.js path
  resolvePlaywrightCoreEntrypoint() -> active Playwright Core entrypoint
  existing shared node_modules root -> Dashi package resolution root
  existing Chromium headless shell resolver -> absolute executable path
  ```

  Record the actual resolver functions and environment variables in the implementation PR. Do not create a second browser cache searcher in Dashi.

- [ ] **Step 2: Implement `resolveDashiPptRuntime()`.**

  Resolve the four existing runtime inputs, validate that every path is absolute and exists, and resolve the Dashi project root from the active Skill/resource path. The resolver must fail with a Chinese actionable error naming the missing existing capability, for example “未找到已激活的 Node.js 运行环境，请重新准备必要组件” or “未找到已准备的 Chromium headless shell，请重新准备浏览器运行时”.

  It must validate the Dashi dependency contract against the existing shared `node_modules` root. The required package set comes from the pinned Dashi lockfile: `gsap`, `html-to-image`, `pptxgenjs`, `react`, `react-dom`, `tsx`, `esbuild`, `pngjs`, `playwright-core`, and `pdf-lib`. Missing packages are an existing runtime ownership issue; do not solve the gap by adding a Dashi-specific functional module.

- [ ] **Step 3: Adapt Dashi’s browser path script to injected paths.**

  Through the local patch, make `chrome-path.mjs` obey:

  ```text
  COPIS_PLAYWRIGHT_HEADLESS_SHELL -> existing absolute headless shell
  COPIS_PLAYWRIGHT_CORE_ENTRY -> existing Playwright Core entrypoint when the script needs it
  ```

  The script must not run `which chrome`, inspect arbitrary system application paths, download browsers, or fall back to a user-installed Chrome in Copis mode. Keep the upstream fallback behavior only for non-Copis standalone use if it can be isolated without changing Copis execution.

- [ ] **Step 4: Set runtime environment variables from the existing Agent runtime builder.**

  Extend the existing typed runtime environment with Dashi-specific values that are paths into existing resources, not functional-module names:

  ```text
  COPIS_DASHI_PPT_ROOT
  COPIS_DASHI_PPT_PROJECT_ROOT
  COPIS_NODE_MODULES_ROOT
  COPIS_PLAYWRIGHT_CORE_ENTRY
  COPIS_PLAYWRIGHT_HEADLESS_SHELL
  ```

  Keep path merging case-insensitive on Windows. Do not add `dashi-ppt` to `FunctionalModuleName`, `FUNCTIONAL_MODULE_DEFINITIONS`, or `functional-module-versions.json`.

- [ ] **Step 5: Add runtime adapter tests.**

  Cover:

  ```text
  all existing runtimes active -> typed Dashi runtime resolves
  node-runtime absent -> fails with existing Node runtime error
  playwright-core absent -> fails with existing Playwright Core error
  headless shell absent -> fails without searching system Chrome
  required shared package missing -> identifies the missing package
  relative/outside paths -> rejected
  Windows executable/path normalization -> accepted only for target platform
  ```

- [ ] **Step 6: Run focused tests and commit the reuse boundary.**

  ```bash
  bun test apps/electron/src/main/lib/dashi-ppt-runtime.test.ts
  bun test apps/electron/src/main/lib/playwright-core-runtime.test.ts
  bun test apps/electron/scripts/sync-runtime-deps.test.ts
  ```

### Task 4: Expose Dashi Through the Existing Copis CLI and Rust Permission Boundary

**Files:**
- Modify the existing compiled CLI dispatch source used by `apps/electron/scripts/compiled-runtime-entry.ts`.
- Modify: `apps/electron/src/main/lib/agent-runtime-env.ts` and its tests.
- Modify: `apps/electron/src/main/lib/agent-rpc-service.ts` or the existing Agent runtime builder.
- Modify: `native/http-api-server/src/agent_files.rs` and its separate tests.
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` only if existing typed command registration requires it.

**Interfaces:**
- Consumes: `COPIS_CLI`, `COPIS_RUNTIME_ROOT`, `DashiPptRuntime`, and current workspace command context.
- Produces: `copis dashi-ppt <subcommand> ...`, executed with existing Copis runtimes and governed by the existing Rust project-command policy.

- [ ] **Step 1: Define the structured Dashi command surface.**

  Support only:

  ```text
  copis dashi-ppt version
  copis dashi-ppt layout:query -- <args>
  copis dashi-ppt inspect:layout -- <args>
  copis dashi-ppt props:safe -- <args>
  copis dashi-ppt goal:scaffold -- <args>
  copis dashi-ppt media:stage -- <args>
  copis dashi-ppt render --goal <goal.json> --output <index.html>
  copis dashi-ppt validate:goal-spec -- <goal.json>
  copis dashi-ppt validate:swiss -- <index.html>
  copis dashi-ppt validate:goal-copy -- <goal.json> <index.html>
  copis dashi-ppt preview --output-dir <directory> --port <port>
  copis dashi-ppt export:pptx -- <ppt-directory> <output.pptx>
  copis dashi-ppt export:pdf -- <ppt-directory> <output.pdf>
  copis dashi-ppt check-latest-version
  ```

  The bridge must invoke the Dashi script with the existing Node executable and existing dependency root. It must pass the existing Playwright Core and headless shell paths through environment variables. It must never expose a generic `node <arbitrary-file>` entrypoint.

- [ ] **Step 2: Keep Dashi command execution in the existing compiled-runtime boundary.**

  Add only a Dashi subcommand branch next to the existing CLI/`__pi-worker` routing. Development and packaged execution must resolve the same logical command. The bridge must pass the caller workspace as an explicit parameter and keep the Dashi project source read-only.

- [ ] **Step 3: Enforce the Rust allowlist.**

  Extend `validate_project_command()` for the executable `copis` with the exact second argument `dashi-ppt` and the subcommands above. Reject:

  ```text
  copis __pi-worker from project bash
  copis dashi-ppt <unknown-subcommand>
  copis dashi-ppt ... | ...
  copis dashi-ppt ... && ...
  copis dashi-ppt with output paths outside the workspace
  copis dashi-ppt invoking arbitrary script paths
  ```

  Keep the existing approval/permission mode and workspace path checks. Automation and delegation sessions must not gain a broader command surface through this adapter.

- [ ] **Step 4: Keep environment values out of model-visible output.**

  Reuse existing stderr sanitization conventions for runtime paths, browser paths, API endpoints, and credentials. Dashi command output may expose workspace-relative output paths and validation errors, but not absolute module/cache paths.

- [ ] **Step 5: Add bridge tests.**

  Cover:

  ```text
  active existing runtimes -> copis dashi-ppt version succeeds
  render/export commands -> accepted and use workspace paths
  unknown Dashi command -> rejected
  arbitrary script argument -> rejected
  shell metacharacter chain -> rejected
  output outside project root -> rejected
  missing existing runtime -> stable actionable error
  runtime paths are sanitized from visible errors
  ```

- [ ] **Step 6: Run TypeScript and Rust bridge tests.**

  ```bash
  bun test apps/electron/src/main/lib/agent-runtime-env.test.ts
  bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
  cargo test --manifest-path native/http-api-server/Cargo.toml agent_files
  ```

### Task 5: Preserve Default Skill Injection and Workspace Safety

**Files:**
- Modify: `apps/electron/src/main/lib/agent-workspace-manager.test.ts`.
- Modify: `apps/electron/src/main/lib/config-paths.test.ts`.
- Modify: `apps/electron/src/main/lib/default-skills-manifest.test.ts`.
- Verify without changing unless required: `apps/electron/src/main/lib/config-paths.ts`, `apps/electron/src/main/lib/agent-workspace-manager.ts`, and `apps/electron/electron-builder.yml`.

**Interfaces:**
- Consumes: The generated `dashi-ppt` default Skill and existing version-based seed/upgrade functions.
- Produces: New and existing workspaces with an active `dashi-ppt` Skill, without copying runtime `node_modules` or browser cache directories.

- [ ] **Step 1: Test first-start seeding.**

  Add a BDD test:

  ```text
  Given a fresh temporary HOME and a bundled default-skills directory containing dashi-ppt
  When seedDefaultSkills() and createAgentWorkspace() run
  Then ~/.copis/default-skills/dashi-ppt/SKILL.md exists
  And the workspace .agents/skills/dashi-ppt/SKILL.md exists
  And dashi-ppt is active by default
  ```

- [ ] **Step 2: Test existing-workspace injection and version upgrade.**

  Add tests that a workspace created before Dashi was bundled receives `dashi-ppt` during `upgradeDefaultSkillsInWorkspaces()`, and that a copied `0.4.2` Dashi Skill is replaced by `0.4.3` while an intentionally inactive Dashi Skill remains inactive after upgrade.

- [ ] **Step 3: Test runtime filtering.**

  Use a fixture containing `project/node_modules`, `.playwright-browsers`, `project/dist`, `.links`, and normal Skill assets. Assert that the default Skill copy and workspace upgrade preserve normal Skill files but omit runtime dependency/browser directories according to existing filters. Do not weaken the generic blocklist.

- [ ] **Step 4: Test retired PPT migration behavior.**

  Assert that `pptx` and `guizang-ppt-skill` remain removed from default and workspace Skill directories, while `dashi-ppt` is not considered retired. Do not add a legacy alias from `pptx` to `dashi-ppt`.

- [ ] **Step 5: Verify packaging input.**

  Check `electron-builder.yml` includes the generated default Skill and does not add a second copy of existing runtime modules. The app bundle must contain Skill metadata and required static theme assets, while runtime Node/browser ownership remains with the existing resources and functional-module activation path.

- [ ] **Step 6: Run workspace lifecycle tests.**

  ```bash
  bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts
  bun test apps/electron/src/main/lib/config-paths.test.ts
  bun test apps/electron/src/main/lib/default-skills-manifest.test.ts
  ```

### Task 6: Add Build Checks Without Adding a Dashi Module

**Files:**
- Modify root `package.json` only if needed for Skill sync/check scripts.
- Modify: `apps/electron/package.json` from `0.0.64` to `0.0.65` after implementation.
- Modify synchronized `bun.lock`.
- Modify: `apps/electron/scripts/build-main.test.ts` only if the Dashi CLI bridge is part of the compiled main/CLI entry.
- Verify: `apps/electron/electron-builder.yml`, `build.sh`, `build.ps1`, `deploy.sh`, `deploy.ps1`.

**Interfaces:**
- Consumes: Generated Skill and runtime adapter/CLI bridge.
- Produces: An Electron build that packages the Skill and reuses existing runtime artifacts without changing functional-module deployment.

- [ ] **Step 1: Add only Skill maintenance scripts.**

  If missing, add:

  ```json
  {
    "sync:dashi-ppt": "bash apps/electron/scripts/sync-dashi-ppt-skill.sh --write",
    "check:dashi-ppt": "bash apps/electron/scripts/sync-dashi-ppt-skill.sh --check",
    "test:dashi-ppt-sync": "bash apps/electron/scripts/test-dashi-ppt-sync.sh"
  }
  ```

  Do not add `build:dashi-ppt-module`, `--dashi-ppt`, `COPIS_DASHI_PPT_ARCHIVE`, or any Dashi functional-module publishing command.

- [ ] **Step 2: Verify existing runtime module boundaries.**

  Assert that Node.js runtime and Playwright Core continue to be built/published by their existing scripts, and Dashi changes do not alter:

  ```text
  scripts/build-node-runtime-module.ts
  scripts/build-playwright-core-module.ts
  scripts/build-functional-module-manifest.ts
  scripts/publish-functional-modules.ts
  scripts/functional-module-version-lock.ts
  deploy.sh
  deploy.ps1
  ```

  If the existing headless shell is prepared by a shared browser owner, assert that Dashi consumes its path but does not add a second artifact.

- [ ] **Step 3: Update only required package versions.**

  After Skill/runtime changes pass, increment `@copis/electron` from `0.0.64` to `0.0.65` and synchronize `bun.lock`. Do not change versions of Node runtime, Playwright Core, or any functional module for Dashi work.

- [ ] **Step 4: Run build checks.**

  ```bash
  bun run sync:dashi-ppt
  bun run check:dashi-ppt
  bun run test:dashi-ppt-sync
  bun run typecheck
  bun run --filter='@copis/electron' build:main
  bun run --filter='@copis/electron' build:renderer
  ```

### Task 7: End-to-End BDD Verification and Handoff

**Files:**
- Create: a small Dashi runtime smoke test next to `dashi-ppt-runtime.test.ts` or the existing CLI bridge test owner.
- Test: all focused tests from Tasks 1-6.
- Documentation: this plan only; `README.md` and `AGENTS.md` require separate permission.

**Interfaces:**
- Consumes: Existing activated Node runtime, shared `node_modules`, Playwright Core, Chromium headless shell, generated Dashi Skill, and a temporary Copis workspace.
- Produces: Automated evidence for runtime reuse, generation, validation, export, upgrade, and failure behavior.

- [ ] **Step 1: Add a deterministic generation fixture.**

  Store a small goal fixture with one cover and one content layout, no external media, a fixed theme pack, unique layouts, and all visible copy fields populated. The fixture must be written under a temporary workspace during tests, never under the Skill source output directory.

- [ ] **Step 2: Verify no dependency installation occurs.**

  Run the Dashi bridge with network access disabled and assert that it succeeds using existing runtime paths. Instrument or mock process execution so the test fails if it invokes `npm install`, `npm ci`, `npx playwright install`, or a browser download command.

- [ ] **Step 3: Verify existing runtime reuse.**

  Assert that the spawned Dashi process receives:

  ```text
  COPIS_RUNTIME_ROOT from the active node-runtime module
  COPIS_NODE_MODULES_ROOT from the existing shared node_modules owner
  COPIS_PLAYWRIGHT_CORE_ENTRY from the active playwright-core module
  COPIS_PLAYWRIGHT_HEADLESS_SHELL from the existing Chromium shell resolver
  ```

  The test must confirm these values are not copied into the workspace Skill or a Dashi-specific module directory.

- [ ] **Step 4: Test render, preview, and explicit exports.**

  Run `render`, `validate:goal-spec`, `validate:swiss`, and `validate:goal-copy`; start the Dashi preview service on a temporary loopback port; then run explicit PPTX and PDF exports. Verify generated files remain inside the workspace output directory and the browser process uses the existing headless shell path.

- [ ] **Step 5: Test missing-runtime behavior.**

  Remove each existing runtime input from the test environment in turn. The command must fail with an actionable existing-component error and must not attempt a network installation or system Chrome fallback. A missing Dashi Skill must remain distinguishable from a missing shared runtime.

- [ ] **Step 6: Test Skill upgrade and old Skill retirement.**

  Verify a pre-Dashi workspace receives `dashi-ppt` version `0.4.3`, old `pptx` and `guizang-ppt-skill` entries are removed as already-retired defaults, and the runtime modules remain untouched by Skill upgrade.

- [ ] **Step 7: Run the complete verification set.**

  ```bash
  bun test apps/electron/src/main/lib/default-skills-manifest.test.ts
  bun test apps/electron/src/main/lib/config-paths.test.ts
  bun test apps/electron/src/main/lib/agent-workspace-manager.test.ts
  bun test apps/electron/src/main/lib/dashi-ppt-runtime.test.ts
  bun test apps/electron/src/main/lib/agent-runtime-env.test.ts
  bun test apps/electron/src/main/lib/agent-rpc-service.test.ts
  bun test apps/electron/src/main/lib/playwright-core-runtime.test.ts
  bun test apps/electron/scripts/build-main.test.ts
  cargo test --manifest-path native/http-api-server/Cargo.toml agent_files
  bun run typecheck
  bun run --filter='@copis/electron' build:main
  bun run --filter='@copis/electron' build:renderer
  ```

- [ ] **Step 8: Perform manual Electron acceptance.**

  In a real Electron window, the user must confirm:

  ```text
  设置/工作区能看到并加载 Dashi PPT 内置 Skill
  Agent 制作 PPT 时使用已有运行时，不要求系统 Node.js/npm/Chrome
  生成的 HTML 预览可在 Copis 内置浏览器打开
  PPTX/PDF 明确导出请求可以完成
  现有 Node.js、Playwright 和浏览器模块的状态没有新增重复项
  ```

  DOM-only checks and screenshots are not substitutes for this confirmation.

## Acceptance Criteria

- A fresh Copis workspace automatically receives an active `dashi-ppt` Skill with frontmatter version `0.4.3`.
- Existing workspaces receive the Skill through the existing version-based upgrade path, and inactive user choice is preserved.
- `pptx` and `guizang-ppt-skill` remain retired and are not silently aliased to Dashi.
- The Dashi Skill is reproducibly synchronized from a pinned upstream source with a local patch and preserved attribution.
- Dashi execution reuses existing Node.js, shared `node_modules`, Playwright Core, and Chromium headless shell paths; no Dashi-specific functional module or duplicate browser archive is created.
- No Dashi path invokes `npm install`, `npm ci`, `npx playwright install`, browser downloads, or system Chrome discovery in Copis execution.
- Rust accepts only the defined Dashi command surface and enforces the existing workspace read/write policy.
- A generated deck passes Dashi goal/spec/Swiss/copy validation, previews over the approved local service, and exports PPTX/PDF only on explicit request.
- OfficeCLI remains the route for existing Office document inspection and structural editing; Dashi is the route for new visual presentation generation.
- Existing functional-module manifest, version-lock, COS publishing, deployment scripts, and settings module list remain unchanged for Dashi.
- Electron main/renderer builds, focused Bun tests, Rust Agent-file tests, runtime reuse tests, and manual Electron acceptance are complete before reporting the feature as done.

## Self-Review

- **Spec coverage:** Upstream submodule, patch merge, metadata, drift tests, dependency/browser reuse, runtime adapter, CLI bridge, Rust policy, default Skill upgrade, old Skill retirement, Office routing, package version bump, build boundaries, BDD tests, and manual Electron acceptance each have an explicit task.
- **No duplicate module:** The document contains no Dashi functional-module artifact, functional-module version lock, COS upload, deployment flag, settings row, or separate Node/Playwright/Chromium archive.
- **Placeholder scan:** The plan contains no `TBD`, `TODO`, “implement later”, or unspecified “add appropriate handling” steps. Paths, versions, command names, environment variables, and test commands are concrete.
- **Boundary review:** Existing modules own installation and upgrades; Dashi owns only source sync and adapter wiring; Rust remains the command authority; README/AGENTS changes are explicitly gated on user permission.
