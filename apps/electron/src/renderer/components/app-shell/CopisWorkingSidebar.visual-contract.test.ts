import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sidebarStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSidebar.css'), 'utf8')
const sidebarSource = readFileSync(join(import.meta.dir, 'CopisWorkingSidebar.tsx'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

describe('Working 侧边栏视觉契约', () => {
  test('Given 会话行 When 鼠标悬停 Then 显示删除入口且不会删除运行中的会话', () => {
    const deleteRule = sidebarStyles.match(
      /\.copis-working-conversation-delete\s*\{([^}]*)\}/s,
    )?.[1]

    expect(deleteRule).toBeDefined()
    expect(sidebarSource).toContain('Trash2')
    expect(sidebarSource).toContain('className="copis-working-conversation-delete"')
    expect(sidebarSource).toContain('disabled={busy || streamState?.running === true}')
    expect(sidebarSource).toContain('event.stopPropagation()')
    expect(sidebarSource).toContain('setPendingDeleteSession({ id: sessionId, title })')
    expect(sidebarSource).toContain('open={pendingDeleteSession !== null}')
    expect(sidebarSource).toContain('className="bg-[var(--ui-primary)] text-[var(--ui-primary-foreground)] hover:brightness-105"')
    expect(sidebarSource).not.toContain('window.confirm(`确定删除会话')
    expect(sidebarSource).toContain('window.electronAPI.deleteAgentSession(sessionId)')
    expect(sidebarSource).toContain('executeClose(sessionId, { clearCompletionNotice: false })')
    expect(sidebarStyles).toContain('.copis-working-conversation-row:hover .copis-working-conversation-delete')
    expect(sidebarStyles).toContain('.copis-working-conversation-row:focus-within .copis-working-conversation-delete')
    expect(deleteRule).toContain('opacity: 0')
    expect(deleteRule).toContain('pointer-events: none')
  })

  test('Given 项目列表 When 显示本地项目标签 Then 使用全局 primary badge 配色', () => {
    const projectBadgeRule = sidebarStyles.match(
      /\.copis-working-project-main > small\s*\{([^}]*)\}/s,
    )?.[1]
    const primaryBadgeRule = globalStyles.match(/\.ui-primary-badge\s*\{([^}]*)\}/s)?.[1]

    expect(projectBadgeRule).toBeDefined()
    expect(primaryBadgeRule).toBeDefined()
    expect(sidebarSource).toContain('<small className="ui-primary-badge">本地</small>')
    expect(projectBadgeRule).toContain('border-radius: 999px')
    expect(projectBadgeRule).not.toContain('color: #8f8f99')
    expect(primaryBadgeRule).toContain('background-color: var(--ui-primary-background)')
    expect(primaryBadgeRule).toContain('color: var(--ui-primary)')
    expect(primaryBadgeRule).toContain('var(--ui-primary)')
  })

  test('Given 专家团队会话 When 显示在项目列表 Then 使用统一 primary 标签并保留团队名称', () => {
    expect(sidebarSource).toContain('const isExpertTeamSession = session.expertTeamSession !== undefined')
    expect(sidebarSource).toContain("<small className=\"ui-primary-badge\">{session.expertTeamSession ? '专家团队' : '组建中'}</small>")
    expect(sidebarSource).toContain("sessionTitle.replace(/^专家团队\\s*·\\s*/, '')")
    expect(sidebarStyles).toContain('.copis-working-conversation-label')
    expect(sidebarStyles).toContain('.copis-working-conversation-label > small.ui-primary-badge')
    expect(sidebarStyles).toContain('color: var(--ui-primary)')
  })

  test('Given 新专家团筹备会话 When 显示在项目列表 Then 使用「组建中」primary 标签', () => {
    expect(sidebarSource).toContain('session.expertTeamSetup === true')
    expect(sidebarSource).toContain('session.expertTeamSession ? \'专家团队\' : \'组建中\'')
  })

  test('Given 主侧边栏 When 查看菜单 Then 不展示新专家团入口（入口保留在专家团队工作台左侧栏）', () => {
    expect(sidebarSource).not.toContain('className="copis-working-menu-button expert-team-create"')
    expect(sidebarSource).not.toContain('CopisWorkingNewExpertTeamDialog')
    expect(sidebarStyles).not.toContain('.copis-working-menu-button.expert-team-create')
    expect(sidebarStyles).not.toContain('.copis-working-sidebar-expert-team-mark')
    expect(sidebarSource).not.toContain('expertTeamSetup: true')
  })

  test('Given Working footer When 检查账户图标标记 Then 使用 primary 背景与图标颜色', () => {
    const accountMarkRule = sidebarStyles.match(
      /\.copis-working-account-mark\s*\{([^}]*)\}/s,
    )?.[1]
    const rootRule = globalStyles.match(/:root\s*\{([^}]*)\}/s)?.[1]

    expect(accountMarkRule).toBeDefined()
    expect(rootRule).toBeDefined()
    expect(rootRule).toContain('--ui-primary: #f3af6b')
    expect(rootRule).toContain('--ui-primary-background: rgb(240 161 90 / 10%)')
    expect(rootRule).toContain('--ui-primary-foreground: #2b2137')
    expect(accountMarkRule).toContain('background: var(--ui-primary-background)')
    expect(accountMarkRule).toContain('color: var(--ui-primary)')
    expect(accountMarkRule).not.toContain('background: var(--ui-primary)')
    expect(accountMarkRule).not.toContain('color: var(--ui-primary-foreground)')
    expect(accountMarkRule).not.toContain('color: hsl(var(--primary))')
    expect(accountMarkRule).not.toContain('#c8a7ff')
  })

  test('Given 最后一个项目靠近侧栏底部 When 打开项目菜单 Then 菜单向上弹出避免被下方组件遮盖', () => {
    expect(sidebarSource).toContain('getBoundingClientRect()')
    expect(sidebarSource).toContain('setOpenMenuDirection')
    expect(sidebarSource).toContain("'menu-up'")
    expect(sidebarStyles).toContain('.copis-working-project-row.menu-up .copis-working-project-menu')
    expect(sidebarStyles).toContain('top: auto')
    expect(sidebarStyles).toContain('bottom: 30px')
  })

  test('Given 侧边栏 When 查看项目标题 Then 创建工作区按钮位于标题右侧并使用加号图标', () => {
    expect(sidebarSource).not.toContain('<span>创建工作区</span>')
    expect(sidebarSource).toContain('className="copis-working-project-heading-actions"')
    expect(sidebarSource).toContain('className="copis-working-project-create"')
    expect(sidebarSource).toContain('aria-label="创建工作区"')
    expect(sidebarSource).toContain('<Plus aria-hidden="true" />')
    expect(sidebarStyles).toContain('.copis-working-project-heading-actions')
    expect(sidebarStyles).toContain('.copis-working-project-create')
  })

  test('Given 工作区列表 When 固定了开发项目 Then 左侧我的项目分组展示固定项目并支持展开折叠', () => {
    expect(sidebarSource).toContain('我的项目')
    expect(sidebarSource).toContain('工作区')
    expect(sidebarSource).toContain('pinnedDevProjectsAtom')
    expect(sidebarSource).toContain('pinnedProjectEntries')
    expect(sidebarSource).toContain('copis-working-project-pinned-row')
    expect(sidebarSource).not.toContain('{pinnedProjectEntries.length > 0 && (')
    expect(sidebarSource).toContain('暂无固定项目，在右侧项目列表点击图钉添加')
    expect(sidebarSource).toContain('aria-expanded={!pinnedGroupCollapsed}')
    expect(sidebarSource).toContain('aria-expanded={!workspaceGroupCollapsed}')
    expect(sidebarSource).not.toContain('pinnedWorkspaceIds')
    expect(sidebarStyles).toContain('.copis-working-project-group-toggle')
    expect(sidebarStyles).toContain('.copis-working-project-group-chevron')
    expect(sidebarStyles).toContain('.copis-working-project-pinned-row')
    expect(sidebarStyles).toContain('.copis-working-project-pinned-empty')
    expect(sidebarStyles).toContain('color: var(--ui-primary)')
  })

  test('Given 项目分组 When 查看左侧对齐 Then 与顶部菜单保持同一文字起点与左边缘', () => {
    const menuRule = sidebarStyles.match(/\.copis-working-menu-button\s*\{([^}]*)\}/s)?.[1]
    const headingRule = sidebarStyles.match(
      /\.copis-working-project-group-heading\s*\{([^}]*)\}/s,
    )?.[1]
    const toggleRule = sidebarStyles.match(
      /\.copis-working-project-group-toggle\s*\{([^}]*)\}/s,
    )?.[1]
    const pinnedRule = sidebarStyles.match(
      /\.copis-working-project-pinned-row\s*\{([^}]*)\}/s,
    )?.[1]
    const mainRule = sidebarStyles.match(
      /\.copis-working-project-main\s*\{([^}]*)\}/s,
    )?.[1]

    expect(menuRule).toBeDefined()
    expect(menuRule).toContain('grid-template-columns: 18px minmax(0, 1fr)')
    expect(menuRule).toContain('gap: 8px')

    // 分组标题按钮与菜单按钮左边缘对齐
    expect(headingRule).toContain('padding-left: 0')
    expect(toggleRule).toContain('padding: 5px 8px')
    expect(toggleRule).toContain('grid-template-columns: 18px minmax(0, 1fr) auto')
    expect(toggleRule).toContain('gap: 8px')

    // 固定项目与工作区行的文字与分组标题/菜单文字同一列起点（18px 图标列 + 8px 间距）
    expect(pinnedRule).toContain('grid-template-columns: 18px minmax(0, 1fr)')
    expect(pinnedRule).toContain('gap: 8px')
    expect(mainRule).toContain('grid-template-columns: 18px minmax(0, 1fr) auto')
    expect(mainRule).toContain('gap: 8px')
  })
})
