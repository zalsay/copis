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

  test('Given 项目会话行 When 显示会话名称 Then 使用较小字号且不改变会话元信息字号', () => {
    const conversationNameRule = sidebarStyles.match(
      /\.copis-working-conversation-label > span\s*\{([^}]*)\}/s,
    )?.[1]
    const conversationMetaRule = sidebarStyles.match(
      /\.copis-working-conversation-row small\s*\{([^}]*)\}/s,
    )?.[1]

    expect(conversationNameRule).toBeDefined()
    expect(conversationNameRule).toContain('font-size: 12px')
    expect(conversationMetaRule).toBeDefined()
    expect(conversationMetaRule).toContain('font-size: 12px')
  })

  test('Given 工作区项目 When 查看项目名称 Then 不展示本地标签并保留全局 primary badge 配色契约', () => {
    const projectBadgeRule = sidebarStyles.match(
      /\.copis-working-project-main > small\s*\{([^}]*)\}/s,
    )?.[1]
    const primaryBadgeRule = globalStyles.match(/\.ui-primary-badge\s*\{([^}]*)\}/s)?.[1]
    const workspaceProjectMainStart = sidebarSource.indexOf('className="copis-working-project-main"')
    const workspaceProjectMainEnd = sidebarSource.indexOf('</button>', workspaceProjectMainStart)
    const workspaceProjectMainSource = sidebarSource.slice(workspaceProjectMainStart, workspaceProjectMainEnd)

    expect(projectBadgeRule).toBeDefined()
    expect(primaryBadgeRule).toBeDefined()
    expect(workspaceProjectMainSource).not.toContain('本地')
    expect(workspaceProjectMainSource).not.toContain('ui-primary-badge')
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

  test('Given 浅色模式 When 使用 ui-primary-background Then 激活背景具有更高层次且深色模式保持原值', () => {
    const lightThemeRule = globalStyles.match(
      /:root:not\(\.dark\)\s*\{([^}]*)\}/s,
    )?.[1]

    expect(lightThemeRule).toBeDefined()
    expect(lightThemeRule).toContain('--ui-primary-background: rgb(240 161 90 / 16%)')
    expect(globalStyles).toContain('--ui-primary-background: rgb(240 161 90 / 10%);')
  })

  test('Given 浅色或特殊主题 When 查看 Working 侧栏 Then 普通文字与激活态跟随主题变量', () => {
    const sidebarRule = sidebarStyles.match(
      /\.copis-working-sidebar\s*\{([^}]*)\}/s,
    )?.[1]
    const sharedTextRule = sidebarStyles.match(
      /\.copis-working-menu-button,\s*\.copis-working-project-row,\s*\.copis-working-conversation-row,\s*\.copis-working-sidebar-muted,\s*\.copis-working-sidebar-account\s*\{([^}]*)\}/s,
    )?.[1]
    const iconRule = sidebarStyles.match(
      /\.copis-working-menu-button svg,\s*\.copis-working-project-row svg,\s*\.copis-working-conversation-row svg\s*\{([^}]*)\}/s,
    )?.[1]
    const menuActiveRule = sidebarStyles.match(
      /\.copis-working-menu-button\.active\s*\{([^}]*)\}/s,
    )?.[1]
    const projectActiveRule = sidebarStyles.match(
      /\.copis-working-project-row\.active\s*\{([^}]*)\}/s,
    )?.[1]
    const conversationActiveRule = sidebarStyles.match(
      /\.copis-working-conversation-row\.active\s*\{([^}]*)\}/s,
    )?.[1]

    expect(sidebarRule).toBeDefined()
    expect(sharedTextRule).toBeDefined()
    expect(iconRule).toBeDefined()
    expect(menuActiveRule).toBeDefined()
    expect(projectActiveRule).toBeDefined()
    expect(conversationActiveRule).toBeDefined()
    expect(sidebarRule).toContain('color: hsl(var(--foreground))')
    expect(sharedTextRule).toContain('color: hsl(var(--foreground))')
    expect(iconRule).toContain('color: hsl(var(--muted-foreground))')
    expect(menuActiveRule).toContain('background: var(--ui-primary-background)')
    expect(menuActiveRule).toContain('color: var(--ui-primary)')
    expect(sidebarStyles).toContain('.copis-working-menu-button.active > svg')
    expect(sidebarStyles).toContain('color: var(--ui-primary)')
    expect(projectActiveRule).toContain('background: var(--ui-primary-background)')
    expect(projectActiveRule).toContain('color: var(--ui-primary)')
    expect(conversationActiveRule).toContain('background: var(--ui-primary-background)')
    expect(conversationActiveRule).toContain('color: var(--ui-primary)')
    expect(sidebarStyles).toContain('background: hsl(var(--foreground) / 0.07)')
  })

  test('Given Working 侧栏 When 查看菜单与列表文字 Then 只有激活文字使用加粗字重', () => {
    const menuRule = sidebarStyles.match(
      /\.copis-working-menu-button\s*\{([^}]*)\}/s,
    )?.[1]
    const menuActiveRule = sidebarStyles.match(
      /\.copis-working-menu-button\.active\s*\{([^}]*)\}/s,
    )?.[1]
    const headingRule = sidebarStyles.match(
      /\.copis-working-project-heading\s*\{([^}]*)\}/s,
    )?.[1]
    const groupToggleRule = sidebarStyles.match(
      /\.copis-working-project-group-toggle\s*\{([^}]*)\}/s,
    )?.[1]
    const projectRowRule = sidebarStyles.match(
      /\.copis-working-project-row\s*\{([^}]*)\}/s,
    )?.[1]
    const projectActiveMainRule = sidebarStyles.match(
      /\.copis-working-project-row\.active\s+\.copis-working-project-main\s*\{([^}]*)\}/s,
    )?.[1]
    const pinnedNameRule = sidebarStyles.match(
      /\.copis-working-project-pinned-name\s*\{([^}]*)\}/s,
    )?.[1]
    const conversationRowRule = sidebarStyles.match(
      /\.copis-working-conversation-row\s*\{([^}]*)\}/s,
    )?.[1]
    const conversationLabelRule = sidebarStyles.match(
      /\.copis-working-conversation-label\s*>\s*span\s*\{([^}]*)\}/s,
    )?.[1]
    const conversationActiveLabelRule = sidebarStyles.match(
      /\.copis-working-conversation-row\.active\s+\.copis-working-conversation-label\s*>\s*span\s*\{([^}]*)\}/s,
    )?.[1]

    expect(menuRule).toBeDefined()
    expect(menuActiveRule).toBeDefined()
    expect(headingRule).toBeDefined()
    expect(groupToggleRule).toBeDefined()
    expect(projectRowRule).toBeDefined()
    expect(projectActiveMainRule).toBeDefined()
    expect(pinnedNameRule).toBeDefined()
    expect(conversationRowRule).toBeDefined()
    expect(conversationLabelRule).toBeDefined()
    expect(conversationActiveLabelRule).toBeDefined()
    expect(menuRule).toContain('font-weight: 400')
    expect(menuActiveRule).toContain('font-weight: 600')
    expect(headingRule).toContain('font-weight: 400')
    expect(groupToggleRule).toContain('font-weight: 400')
    expect(projectRowRule).toContain('font-weight: 400')
    expect(projectActiveMainRule).toContain('font-weight: 600')
    expect(pinnedNameRule).toContain('font-weight: 400')
    expect(conversationRowRule).toContain('font-weight: 400')
    expect(conversationLabelRule).toContain('font-weight: 400')
    expect(conversationActiveLabelRule).toContain('font-weight: 600')
  })

  test('Given Working footer When 查看反馈与账户文字 Then 使用常规字重', () => {
    const accountStrongRule = sidebarStyles.match(
      /\.copis-working-sidebar-account strong\s*\{([^}]*)\}/s,
    )?.[1]
    const balanceRule = sidebarStyles.match(
      /\.copis-working-account-balance\s*\{([^}]*)\}/s,
    )?.[1]

    expect(accountStrongRule).toBeDefined()
    expect(balanceRule).toBeDefined()
    expect(accountStrongRule).toContain('font-weight: 400')
    expect(balanceRule).toContain('font-weight: 400')
  })

  test('Given 工作区菜单 When 删除工作区 Then 使用统一项目确认弹窗', () => {
    expect(sidebarSource).toContain("import { ConfirmDialog } from '@/components/ui/confirm-dialog'")
    expect(sidebarSource).toContain('pendingDeleteWorkspace')
    expect(sidebarSource).toContain('open={pendingDeleteWorkspace !== null}')
    expect(sidebarSource).toContain('title={`确认删除项目「${pendingDeleteWorkspace?.name}」？`}')
    expect(sidebarSource).toContain('loadingLabel="删除中..."')
    expect(sidebarSource).not.toContain('window.confirm(`确定删除项目')
  })

  test('Given 最后一个项目靠近侧栏底部 When 打开项目菜单 Then 菜单向上弹出避免被下方组件遮盖', () => {
    expect(sidebarSource).toContain('getBoundingClientRect()')
    expect(sidebarSource).toContain('setOpenMenuDirection')
    expect(sidebarSource).toContain("'menu-up'")
    expect(sidebarStyles).toContain('.copis-working-project-row.menu-up .copis-working-project-menu')
    expect(sidebarStyles).toContain('top: auto')
    expect(sidebarStyles).toContain('bottom: 30px')
  })

  test('Given 侧边栏 When 查看项目标题 Then 刷新按钮位于我的项目且创建按钮保留在工作区', () => {
    expect(sidebarSource).not.toContain('<span>创建工作区</span>')
    expect(sidebarSource).toContain('className="copis-working-project-heading-actions"')
    expect(sidebarSource).toContain('<Plus aria-hidden="true" />')
    expect(sidebarStyles).toContain('.copis-working-project-heading-actions')
    expect(sidebarStyles).toContain('.copis-working-project-create')

    const pinnedHeadingStart = sidebarSource.indexOf(
      'className="copis-working-project-group-toggle copis-working-project-pinned-toggle"',
    )
    const pinnedHeadingEnd = sidebarSource.indexOf('</div>', pinnedHeadingStart)
    const pinnedHeadingSource = sidebarSource.slice(pinnedHeadingStart, pinnedHeadingEnd)
    const workspaceHeadingStart = sidebarSource.indexOf(
      'className="copis-working-project-group-toggle copis-working-project-workspace-toggle"',
    )
    const workspaceHeadingEnd = sidebarSource.indexOf('</div>', workspaceHeadingStart)
    const workspaceHeadingSource = sidebarSource.slice(workspaceHeadingStart, workspaceHeadingEnd)

    expect(pinnedHeadingSource).toContain('className={cn(\'copis-working-project-refresh\'')
    expect(pinnedHeadingSource).toContain('onClick={() => void refreshProjects()}')
    expect(pinnedHeadingSource).not.toContain('className="copis-working-project-create"')
    expect(workspaceHeadingSource).not.toContain('copis-working-project-refresh')
    expect(workspaceHeadingSource).toContain('className="copis-working-project-create"')
    expect(workspaceHeadingSource).toContain('aria-label="创建工作区"')
  })

  test('Given 侧边栏 When 未悬停项目标题 Then 刷新按钮默认显示并可点击', () => {
    const refreshRule = sidebarStyles.match(
      /\.copis-working-project-refresh\s*\{([^}]*)\}/s,
    )?.[1]

    expect(refreshRule).toBeDefined()
    expect(refreshRule).toContain('opacity: 1')
    expect(refreshRule).toContain('pointer-events: auto')
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

  test('Given 项目分组 When 悬停分组标题 Then 背景覆盖左侧留白且内容起点与技能市场一致', () => {
    const menuRule = sidebarStyles.match(/\.copis-working-menu-button\s*\{([^}]*)\}/s)?.[1]
    const headingRule = sidebarStyles.match(
      /\.copis-working-project-group-heading\s*\{([^}]*)\}/s,
    )?.[1]
    const toggleRule = sidebarStyles.match(
      /\.copis-working-project-group-toggle\s*\{([^}]*)\}/s,
    )?.[1]
    const pinnedToggleRule = sidebarStyles.match(
      /\.copis-working-project-pinned-toggle\s*\{([^}]*)\}/s,
    )?.[1]
    const pinnedIconRule = sidebarStyles.match(
      /\.copis-working-project-pinned-icon\s*\{([^}]*)\}/s,
    )?.[1]
    const pinnedCountRule = sidebarStyles.match(
      /\.copis-working-project-pinned-toggle\s+\.copis-working-project-group-count\s*\{([^}]*)\}/s,
    )?.[1]
    const pinnedRule = sidebarStyles.match(
      /\.copis-working-project-pinned-row\s*\{([^}]*)\}/s,
    )?.[1]

    expect(menuRule).toBeDefined()
    expect(menuRule).toContain('grid-template-columns: 18px minmax(0, 1fr)')
    expect(menuRule).toContain('gap: 8px')

    const menuPaddingLeft = menuRule?.match(/padding:\s*5px\s+(\d+)px/)?.[1]
    const headingPaddingLeft = headingRule?.match(/padding-left:\s*(\d+)(?:px)?/)?.[1]
    const togglePaddingLeft = toggleRule?.match(/padding:\s*5px\s+(\d+)(?:px)?(?:\s+5px\s+\d+(?:px)?)?/)?.[1]

    expect(menuPaddingLeft).toBe('8')
    expect(headingPaddingLeft).toBe('0')
    expect(togglePaddingLeft).toBe('8')
    expect(Number(headingPaddingLeft) + Number(togglePaddingLeft)).toBe(Number(menuPaddingLeft))
    expect(toggleRule).toContain('grid-template-columns: 18px minmax(0, 1fr) auto')
    expect(toggleRule).toContain('gap: 8px')

    // 第一组标题文字先于箭头，计数固定贴右；第二组标题继续使用相同的图标列布局。
    expect(pinnedToggleRule).toBeDefined()
    expect(pinnedCountRule).toBeDefined()
    const pinnedToggleStart = sidebarSource.indexOf(
      'className="copis-working-project-group-toggle copis-working-project-pinned-toggle"',
    )
    expect(pinnedToggleStart).toBeGreaterThanOrEqual(0)
    const pinnedToggleEnd = sidebarSource.indexOf('</button>', pinnedToggleStart)
    const pinnedToggleSource = sidebarSource.slice(pinnedToggleStart, pinnedToggleEnd)
    expect(pinnedToggleSource.indexOf('<span>我的项目</span>')).toBeLessThan(
      pinnedToggleSource.indexOf('<ChevronRight'),
    )
    expect(pinnedToggleSource).toContain('aria-expanded={!pinnedGroupCollapsed}')
    expect(pinnedToggleSource).toContain('setPinnedGroupCollapsed((current) => !current)')
    expect(pinnedToggleRule).toContain('display: flex')
    expect(pinnedToggleRule).toContain('gap: 8px')
    expect(pinnedCountRule).toContain('margin-left: auto')
    expect(pinnedToggleSource).not.toContain('FolderCode')
    expect(pinnedIconRule).toBeDefined()
    expect(pinnedIconRule).toContain('width: 15px')
    expect(pinnedIconRule).toContain('height: 15px')
    expect(pinnedIconRule).toContain('flex: 0 0 15px')

    const pinnedRowStart = sidebarSource.indexOf(
      'className="copis-working-project-pinned-row"',
    )
    expect(pinnedRowStart).toBeGreaterThanOrEqual(0)
    const pinnedRowEnd = sidebarSource.indexOf('</button>', pinnedRowStart)
    const pinnedRowSource = sidebarSource.slice(pinnedRowStart, pinnedRowEnd)
    expect(pinnedRowSource).toContain(
      '<FolderCode className="copis-working-project-pinned-icon" aria-hidden="true" />',
    )
    expect(pinnedRowSource.indexOf('<FolderCode')).toBeLessThan(
      pinnedRowSource.indexOf('<span className="copis-working-project-pinned-copy">'),
    )
    expect(pinnedRule).toContain('display: flex')
    expect(pinnedRule).toContain('padding: 4px 8px 4px 16px')
    expect(pinnedRule).toContain('gap: 8px')
  })

  test('Given 工作区分组 When 查看标题与项目行 Then 标题不显示图标且各工作区名称前显示状态图标', () => {
    const workspaceLabelIndex = sidebarSource.indexOf('<span>工作区</span>')
    const workspaceToggleStart = sidebarSource.lastIndexOf(
      'className="copis-working-project-group-toggle copis-working-project-workspace-toggle"',
      workspaceLabelIndex,
    )
    const workspaceToggleEnd = sidebarSource.indexOf('</button>', workspaceToggleStart)
    const workspaceToggleSource = sidebarSource.slice(workspaceToggleStart, workspaceToggleEnd)
    const workspaceToggleRule = sidebarStyles.match(
      /\.copis-working-project-workspace-toggle\s*\{([^}]*)\}/s,
    )?.[1]
    const workspaceRowIconRule = sidebarStyles.match(
      /\.copis-working-project-row\s+\.copis-working-project-workspace-row-icon\s*\{([^}]*)\}/s,
    )?.[1]
    const currentWorkspaceRowIconRule = sidebarStyles.match(
      /\.copis-working-project-row\.current-session-workspace\s+\.copis-working-project-workspace-row-icon\s*\{([^}]*)\}/s,
    )?.[1]
    const workspaceCountRule = sidebarStyles.match(
      /\.copis-working-project-workspace-toggle\s+\.copis-working-project-group-count\s*\{([^}]*)\}/s,
    )?.[1]
    const workspaceProjectMainStart = sidebarSource.indexOf('className="copis-working-project-main"')
    const workspaceProjectMainEnd = sidebarSource.indexOf('</button>', workspaceProjectMainStart)
    const workspaceProjectMainSource = sidebarSource.slice(workspaceProjectMainStart, workspaceProjectMainEnd)
    const workspaceRowRule = sidebarStyles.match(
      /\.copis-working-project-row\s*\{([^}]*)\}/s,
    )?.[1]
    const workspaceMainRule = sidebarStyles.match(
      /\.copis-working-project-main\s*\{([^}]*)\}/s,
    )?.[1]
    const conversationListRule = sidebarStyles.match(
      /\.copis-working-conversation-list\s*\{([^}]*)\}\s*\.copis-working-conversation-row/s,
    )?.[1]

    expect(workspaceLabelIndex).toBeGreaterThanOrEqual(0)
    expect(workspaceToggleStart).toBeGreaterThanOrEqual(0)
    expect(workspaceToggleRule).toBeDefined()
    expect(workspaceToggleRule).toContain('display: flex')
    expect(workspaceToggleRule).toContain('gap: 8px')
    expect(workspaceRowIconRule).toBeDefined()
    expect(workspaceRowIconRule).toContain('width: 15px')
    expect(workspaceRowIconRule).toContain('height: 15px')
    expect(workspaceRowIconRule).toContain('flex: 0 0 15px')
    expect(workspaceRowIconRule).toContain('color: hsl(var(--muted-foreground))')
    expect(currentWorkspaceRowIconRule).toBeDefined()
    expect(currentWorkspaceRowIconRule).toContain('color: var(--ui-primary)')
    expect(workspaceCountRule).toBeDefined()
    expect(workspaceCountRule).toContain('margin-left: auto')
    expect(sidebarStyles).not.toContain('.copis-working-project-group-toggle > svg')
    expect(workspaceToggleSource).not.toContain('FolderOpen')
    expect(workspaceToggleSource).toContain('aria-expanded={!workspaceGroupCollapsed}')
    expect(workspaceToggleSource.indexOf('<FolderOpen')).toBeLessThan(
      workspaceToggleSource.indexOf('<span>工作区</span>'),
    )
    expect(workspaceToggleSource.indexOf('<span>工作区</span>')).toBeLessThan(
      workspaceToggleSource.indexOf('<ChevronRight'),
    )
    expect(workspaceToggleSource.indexOf('<ChevronRight')).toBeLessThan(
      workspaceToggleSource.indexOf('<small className="copis-working-project-group-count">{localWorkspaces.length}</small>'),
    )
    expect(workspaceProjectMainSource).toContain(
      '<FolderOpen className="copis-working-project-workspace-row-icon" aria-hidden="true" />',
    )
    expect(workspaceProjectMainSource.indexOf('<FolderOpen')).toBeLessThan(
      workspaceProjectMainSource.indexOf('<span>{workspace.name}</span>'),
    )
    expect(workspaceProjectMainSource).not.toContain('本地')
    expect(workspaceProjectMainSource).not.toContain('ui-primary-badge')
    expect(workspaceRowRule).toBeDefined()
    expect(workspaceRowRule).toContain('padding: 4px 2px 4px 16px')
    expect(workspaceMainRule).toBeDefined()
    expect(workspaceMainRule).toContain('display: flex')
    expect(workspaceMainRule).not.toContain('grid-template-columns')
    expect(workspaceMainRule).toContain('gap: 8px')
    expect(sidebarSource).toContain("isCurrentSessionWorkspace && 'current-session-workspace'")
    expect(conversationListRule).toBeDefined()
    expect(conversationListRule).toContain('padding-left: 16px')
  })

  test('Given 工作区项目行 When 展示其会话列表 Then 项目与首条会话之间保留更明显的间距', () => {
    const projectGroupRule = sidebarStyles.match(
      /\.copis-working-project-group\s*\{([^}]*)\}/s,
    )?.[1]

    expect(projectGroupRule).toBeDefined()
    expect(projectGroupRule).toContain('gap: 6px')
  })
})
