import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const viewSource = readFileSync(join(import.meta.dir, 'ExpertTeamView.tsx'), 'utf8')
const sidebarSource = readFileSync(join(import.meta.dir, '../app-shell/CopisWorkingSidebar.tsx'), 'utf8')
const globalsSource = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')
const primaryBadgeRule = globalsSource.match(/\.ui-primary-badge\s*\{([^}]*)\}/s)?.[1]
const handleStartStart = viewSource.indexOf('const handleStart = React.useCallback')
const handleStartEnd = viewSource.indexOf('\n\n  React.useEffect', handleStartStart)
const handleStartSource = viewSource.slice(handleStartStart, handleStartEnd)

describe('专家团队页头视觉契约', () => {
  test('Given 打开专家团队页 When 渲染页头 Then 不显示额外的团队图标', () => {
    expect(viewSource).not.toContain('UsersRound')
    expect(viewSource).not.toContain('bg-primary/12 text-primary')
    expect(viewSource).not.toContain('Workflow')
  })

  test('Given 打开专家团队页 When 查看依赖编排 Then 展示真实的专家节点顺序与结果回传', () => {
    expect(viewSource).toContain('>专家团队</span>')
    expect(viewSource).not.toContain('>团队 Schema</span>')
    expect(viewSource).toContain('aria-label="专家团队依赖编排"')

    for (const label of [
      'researcher',
      'summary',
      'reviewer',
      '子结果回传主 Agent',
    ]) {
      expect(viewSource).toContain(label)
    }
  })

  test('Given 打开专家团队页 When 查看页头状态徽章 Then 使用全局 primary badge 令牌', () => {
    expect(primaryBadgeRule).toBeDefined()
    expect(globalsSource).toContain('--ui-primary: #f3af6b;')
    expect(globalsSource).toContain('--ui-primary-background: rgb(240 161 90 / 10%);')
    expect(globalsSource).toContain('.ui-primary-badge')
    expect(globalsSource).toContain('.ui-primary-surface')
    expect(globalsSource).toContain('background-color: var(--ui-primary-background)')
    expect(globalsSource).toContain('color: var(--ui-primary)')
    expect(globalsSource).toContain('var(--ui-primary)')
    expect(primaryBadgeRule).toContain('background-color: var(--ui-primary-background)')
    expect(primaryBadgeRule).toContain('color: var(--ui-primary)')
    expect(primaryBadgeRule).toContain(
      'border: 1px solid color-mix(in srgb, var(--ui-primary) 30%, transparent)',
    )
    expect(viewSource).toContain('ui-primary-badge')
    expect(viewSource).not.toContain('border-primary/30 bg-primary/10')
    expect(viewSource).not.toContain('border-[#f0a15a]/30 bg-[#f0a15a]/10')
  })

  test('Given 选择专家团队 Schema When 查看左列 Then 使用全局 primary surface 令牌', () => {
    expect(viewSource).toContain("schema.id === schemaId && 'ui-primary-surface'")
    expect(viewSource).not.toContain("schema.id === schemaId && 'bg-[#f0a15a]/10 text-[#f5c18e]'")
  })

  test('Given 选择专家团队 Schema When 查看工作台 Then 复刻参考页的只读编排层级', () => {
    expect(viewSource).toContain('bg-[#151515]')
    expect(viewSource).toContain('bg-[#1d1e1f]')
    expect(viewSource).toContain('text-[#f0a15a]')
    expect(viewSource).toContain('<h1 className="flex min-w-0 flex-wrap items-center gap-2 text-xl font-semibold">')
    expect((viewSource.match(/<h1\b/g) ?? []).length).toBe(1)
    expect(viewSource).toMatch(/<h1 className="flex min-w-0 flex-wrap items-center gap-2 text-xl font-semibold">[\s\S]*revision \{schemaRevision/)
    expect(viewSource).toContain('revision')
    expect(viewSource).not.toContain('<span className="text-[11px] font-semibold tracking-[0.06em] text-[#f0a15a]">{currentSchema?.name ?? \'专家团队\'}</span>')
    expect(viewSource).toContain('role="status"')
    expect(viewSource).toContain('>执行阵容</h2>')
    expect(viewSource).toContain('>任务路径</h2>')
    expect(viewSource).not.toContain('>Schema 节点</h2>')
    expect(viewSource).not.toContain('>依赖编排</h2>')
    expect(viewSource).toContain('节点详情')
    expect(viewSource).toContain('运行历史')
    expect(viewSource).toContain('currentSchema.edges')
    expect(viewSource).toContain('hoveredNodeId')
    expect(viewSource).toContain('showNodeDetails(node.id, event)')
    expect(viewSource).toContain('hideNodeDetails')
    expect(viewSource).toContain('pinnedNodeId ?? hoveredNodeId')
    expect(viewSource).toContain('onClick={(event) => togglePinNode(node.id, event)}')
    expect(viewSource).not.toContain('currentSchema.nodes[0]')
    expect(viewSource).toContain('dependsOn')
    expect(viewSource).toContain('nodeStates')
    expect(viewSource).not.toContain('contentEditable')
    expect(viewSource).not.toContain('<textarea')
  })

  test('Given 悬停或点击专家节点 When 查看详情 Then 节点详情面板移除并以节点附近悬浮层展示', () => {
    expect(viewSource).not.toContain('aria-label="专家团队节点详情"')
    expect(viewSource).not.toContain('xl:grid-cols-[minmax(0,1.35fr)')
    expect(viewSource).toContain('aria-label="节点详情悬浮层"')
    expect(viewSource).toContain('role="tooltip"')
    expect(viewSource).toContain('getBoundingClientRect()')
    expect(viewSource).toContain('nodeRect')
    expect(viewSource).toContain("position: 'fixed'")
    expect(viewSource).toContain('pinnedNodeId === activeNode.id')
    expect(viewSource).toContain('aria-label="关闭节点详情"')
  })

  test('Given 打开专家团队页 When 查看布局 Then 左侧列表从顶部开始且 header 位于右侧工作台', () => {
    const rootIndex = viewSource.indexOf('<div className="flex h-full min-h-0 bg-[#151515] text-[#f2f3f3]">')
    const asideIndex = viewSource.indexOf('<aside className=')
    const rightWrapperIndex = viewSource.indexOf('aria-label="专家团队右侧工作台"')
    const headerIndex = viewSource.indexOf('<header className=')

    expect(rootIndex).toBeGreaterThanOrEqual(0)
    expect(asideIndex).toBeGreaterThan(rootIndex)
    expect(rightWrapperIndex).toBeGreaterThan(asideIndex)
    expect(headerIndex).toBeGreaterThan(rightWrapperIndex)
    expect(viewSource).not.toContain('title="刷新 Schema"')
    expect(viewSource).not.toContain('>刷新</Button>')
    expect(viewSource).toContain('schemas.map')
    expect(viewSource).toContain('runs.slice')
    expect(viewSource).toContain('void loadSchemas()')
    expect(viewSource).toContain('loadRun')
    expect(viewSource).toContain('cancelRun')
  })

  test('Given 尚未运行专家团队 When 点击页头状态 Then 进入工作区选择与创建流程', () => {
    expect(viewSource).not.toContain("currentRun ? statusLabels[currentRun.status] : '工作区内使用'")
    expect(viewSource).toContain('>开始</Button>')
    expect(viewSource).toContain('Dialog')
    expect(viewSource).toContain('选择工作区')
    expect(viewSource).toContain('创建工作区')
    expect(viewSource).toContain('agentWorkspacesAtom')
    expect(viewSource).toContain('currentAgentWorkspaceIdAtom')
    expect(viewSource).toContain('expertTeamApi.bindWorkspace')
    expect(viewSource).toContain('createWorkspaceDialogOpenAtom')
    expect(viewSource).toContain('createdWorkspaceIdAtom')
    expect(viewSource).toContain("openCreateWorkspaceDialog('expert-team')")
    expect(sidebarSource).toMatch(/workspaceCreationSource\s*!==\s*'expert-team'[\s\S]*openSession\(/)
    expect(viewSource).not.toContain('createAgentWorkspace')
    expect(viewSource).not.toContain('openFolderDialog')
    expect(viewSource).not.toContain('从本地文件夹创建')
  })

  test('Given Schema 已绑定工作区 When 点击开始 Then 进入该工作区已有或新建的 Agent 会话', () => {
    expect(viewSource).toContain('agentSessionsAtom')
    expect(viewSource).toContain('useOpenSession')
    expect(viewSource).toContain('useCreateSession')
    expect(viewSource).toContain('handleStart')
    expect(viewSource).toContain("openSession('agent', session.id, session.title)")
    expect(viewSource).toContain('createAgent({ workspaceId })')
  })

  test('Given Schema 已绑定工作区 When 点击开始 Then 先同步当前工作区且不复用归档会话', () => {
    expect(handleStartSource).toContain('setCurrentWorkspaceId(workspaceId)')
    expect(handleStartSource).toMatch(
      /setCurrentWorkspaceId\(workspaceId\)[\s\S]*agentSessions\.find\(\(item\) => item\.workspaceId === workspaceId && !item\.archived\)/,
    )
  })

  test('Given Schema 未绑定工作区 When 点击开始 Then 打开工作区选择弹窗', () => {
    expect(viewSource).toContain('handleWorkspaceDialogOpenChange(true)')
    expect(viewSource).toContain('onClick={handleStart}')
  })

  test('Given 选择工作区弹窗 When 点击创建工作区 Then 保留创建入口与交互', () => {
    const createWorkspaceButton = viewSource.match(/<Button[^>]*><FolderOpen[^>]*\/>创建工作区<\/Button>/)?.[0]

    expect(createWorkspaceButton).toBeDefined()
    expect(createWorkspaceButton).toContain('text-[var(--ui-primary)]')
    expect(createWorkspaceButton).toContain('bg-[var(--ui-primary-background)]')
    expect(createWorkspaceButton).not.toContain('text-[#f5c18e]')
    expect(createWorkspaceButton).not.toContain('bg-[#f0a15a]/10')
    expect(viewSource).toContain('onClick={handleOpenCreateWorkspace}')
    expect(viewSource).toContain('disabled={workspaceActionLoading}')
  })
})
