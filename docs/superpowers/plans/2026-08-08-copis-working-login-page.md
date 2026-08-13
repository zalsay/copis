# Copis Working 登录页 Implementation Plan

> **For agentic workers:** This plan is executed inline in the current worktree. Keep unrelated existing worktree changes intact.

**Goal:** 将 Copis 未登录入口改造成 ai-education 风格的双栏认证页，左侧展示 `landingPages` 三个主题的单张轮播，右侧保留现有 Working 认证行为。

**Architecture:** 新增无后端依赖的 `CopisWorkingLoginShowcase` 组件，负责三张产品主题、轮播状态、自动切换、暂停和 reduced-motion。现有 `CopisWorkingLoginDialog` 继续负责登录/注册/找回密码及 IPC，只在 `dismissible={false}` 时组合 Showcase 和认证面板；可关闭入口保持原弹窗布局。

**Tech Stack:** React 18, TypeScript, native CSS, lucide-react, Bun test, Vite.

## Global Constraints

- 不修改后端认证接口、IPC 类型、凭据存储、README.md。
- 不新增图片依赖；使用现有 `CopisAppLogo` 和 CSS 产品摘要构图。
- 状态管理保持本地 React state，不引入新的全局状态。
- 认证成功继续调用 `onAuthenticated(WorkingAuthState)`。
- 轮播同时只渲染一张主题；悬停/聚焦暂停；减少动态效果时不自动切换。
- 保留现有设置登录弹窗的 dismissible 和忘记密码行为。

---

### Task 1: Login page behavior contract

**Files:**
- Create: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`
- Reference: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx`

- [ ] 写失败契约，检查 Showcase 独立组件、三张主题标识、轮播控件、full-page 组合类名和现有认证 IPC 调用仍存在。
- [ ] 运行 `bun test apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`，确认在实现前因缺少 Showcase/契约结构而失败。

---

### Task 2: Isolated Landing Page showcase

**Files:**
- Create: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginShowcase.tsx`
- Create: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginShowcase.css`
- Test: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`

**Interfaces:**
- Produces `CopisWorkingLoginShowcase(): React.ReactElement`.
- Exports `COPIS_WORKING_LOGIN_SHOWCASE_SLIDES` as a readonly three-item slide list for contract tests and stable content.

- [ ] 定义三张 slide：Hero、本地 AI 浏览器、Workflow；每张包含 kicker、标题、描述、能力标签和对应 CSS 视觉摘要。
- [ ] 实现 `activeIndex`、上一张/下一张/点选、自动轮播，并在鼠标进入、键盘 focus 进入时暂停。
- [ ] 使用 `window.matchMedia('(prefers-reduced-motion: reduce)')` 禁止 reduced-motion 下的自动轮播。
- [ ] 添加 `aria-label`、`aria-pressed`、`aria-hidden` 和按钮标签，确保当前 slide 可识别。
- [ ] 运行契约测试，确认轮播结构和内容契约通过。

---

### Task 3: Compose full-page authentication layout

**Files:**
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.tsx`
- Modify: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginDialog.css`
- Test: `apps/electron/src/renderer/components/app-shell/CopisWorkingLoginPage.contract.test.ts`

- [ ] 引入 Showcase，并在 `dismissible === false` 时给根认证 section 增加 full-page class。
- [ ] 将既有认证内容包裹为 form panel；全屏模式下变为左轮播/右表单 grid，弹窗模式继续单列。
- [ ] 保持登录、注册、验证码、邀请码、找回密码的 JSX 与 IPC 调用语义不变。
- [ ] 增加桌面、窄窗口和移动端样式，避免表单固定高度裁切；轮播在小宽度时隐藏或降级为顶部可见区域。
- [ ] 运行契约测试并确认旧的视觉契约仍通过。

---

### Task 4: Verification and simplification

**Files:**
- Review only: modified login page files.

- [ ] 运行 `bun run --filter='@copis/electron' typecheck`。
- [ ] 运行 `bun run --filter='@copis/electron' build:renderer`。
- [ ] 运行登录页契约测试和 `CopisWorkingLoginDialog.visual-contract.test.ts`。
- [ ] 运行 `bun run --filter='@copis/electron' build:main`，确认认证入口相关 Electron 构建未受影响。
- [ ] 检查 `git diff --check`，并做一次代码简化检查：删除重复 class、无用状态和不必要的抽象。
- [ ] 交付时明确说明需要用户在实际 Electron 窗口确认视觉效果。
