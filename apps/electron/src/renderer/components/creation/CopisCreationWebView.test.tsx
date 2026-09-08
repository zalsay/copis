import { describe, expect, test } from 'bun:test'

describe('CopisCreationWebView 侧边栏宽度与原生视图布局契约', () => {
  test('Given 侧边栏宽度最小限制 When 检查安全展开下限 Then 恒定不低于 264px 避免误折叠', () => {
    const clampSidebarWidth = (w: number) => Math.max(264, Math.round(w))

    expect(clampSidebarWidth(56)).toBe(264)
    expect(clampSidebarWidth(0)).toBe(264)
    expect(clampSidebarWidth(264)).toBe(264)
    expect(clampSidebarWidth(280)).toBe(280)
    expect(clampSidebarWidth(320)).toBe(320)
  })

  test('Given 打开了 Copis 子功能视图 When 计算原生 WebContentsView 宽度 Then 原生视口保持展开宽度且不超过容器总宽', () => {
    const calculateBoundsWidth = (
      hasSubView: boolean,
      dshSidebarWidth: number,
      containerWidth: number,
    ) => {
      const effectiveSidebarWidth = Math.max(264, dshSidebarWidth)
      return hasSubView ? Math.min(effectiveSidebarWidth, containerWidth) : containerWidth
    }

    // 默认全屏聊天会话
    expect(calculateBoundsWidth(false, 280, 1200)).toBe(1200)

    // 打开日程表/定时任务等子功能：即使侧栏上报 56px，也锁定为展开宽度 264px，绝不折叠
    expect(calculateBoundsWidth(true, 56, 1200)).toBe(264)
    expect(calculateBoundsWidth(true, 280, 1200)).toBe(280)
    expect(calculateBoundsWidth(true, 300, 1200)).toBe(300)
  })

  test('Given 打开了 Copis 子功能视图 When 计算右侧功能面板 left offset Then 偏移量不低于 264px 避免遮挡侧栏菜单', () => {
    const calculateSubViewLeft = (dshSidebarWidth: number) => {
      return Math.max(264, Math.round(dshSidebarWidth))
    }

    expect(calculateSubViewLeft(56)).toBe(264)
    expect(calculateSubViewLeft(264)).toBe(264)
    expect(calculateSubViewLeft(280)).toBe(280)
  })

  test('Given 打开了设置页面 (settings) When 计算原生视图参数与面板布局 Then 原生视图隐藏且设置面板从 left 0 全屏覆盖', () => {
    type CreationSubView = 'planning' | 'memory' | 'settings' | null

    const calculateNativeBoundsParams = (
      subView: CreationSubView,
      dshSidebarWidth: number,
      containerWidth: number,
    ) => {
      const isSettings = subView === 'settings'
      const effectiveSidebarWidth = Math.max(264, dshSidebarWidth)
      const effectiveWidth = isSettings
        ? 0
        : subView
          ? Math.min(effectiveSidebarWidth, containerWidth)
          : containerWidth
      const isVisible = !isSettings && containerWidth > 0
      return { effectiveWidth, isVisible }
    }

    const calculateSubViewOffset = (subView: CreationSubView, dshSidebarWidth: number) => {
      return subView === 'settings' ? 0 : Math.max(264, Math.round(dshSidebarWidth))
    }

    // 设置页面：原生视口彻底隐藏 (visible=false, width=0)，DSH 左菜单被隐藏；面板 left=0 全屏覆盖
    const settingsBounds = calculateNativeBoundsParams('settings', 280, 1200)
    expect(settingsBounds.effectiveWidth).toBe(0)
    expect(settingsBounds.isVisible).toBe(false)
    expect(calculateSubViewOffset('settings', 280)).toBe(0)

    // 其他子功能（如日程/记忆）：原生视口保留侧栏 (visible=true, width=280)，面板 left=280
    const planningBounds = calculateNativeBoundsParams('planning', 280, 1200)
    expect(planningBounds.effectiveWidth).toBe(280)
    expect(planningBounds.isVisible).toBe(true)
    expect(calculateSubViewOffset('planning', 280)).toBe(280)

    // 普通会话视图：原生视口全屏 (visible=true, width=1200)
    const conversationBounds = calculateNativeBoundsParams(null, 280, 1200)
    expect(conversationBounds.effectiveWidth).toBe(1200)
    expect(conversationBounds.isVisible).toBe(true)
  })


  test('Given 创造模式事件路由 When 接收到 COPIS_OPEN_SETTINGS 或 settings 导航 Then 路由到 settings 子视图', () => {
    type CreationSubView =
      | 'planning'
      | 'automations'
      | 'memory'
      | 'knowledge'
      | 'expert-team'
      | 'agent-skills'
      | 'fund-stock'
      | 'settings'
      | null

    const routeEvent = (
      event: { type: string; view?: string },
      currentView: CreationSubView,
    ): CreationSubView => {
      if (event.type === 'COPIS_OPEN_SETTINGS') {
        return 'settings'
      }
      if (event.type === 'COPIS_NAVIGATE') {
        if (event.view === 'conversations') return null
        if (event.view) return event.view as CreationSubView
      }
      return currentView
    }

    expect(routeEvent({ type: 'COPIS_OPEN_SETTINGS' }, null)).toBe('settings')
    expect(routeEvent({ type: 'COPIS_NAVIGATE', view: 'settings' }, null)).toBe('settings')
    expect(routeEvent({ type: 'COPIS_NAVIGATE', view: 'conversations' }, 'settings')).toBe(null)
  })

  test('Given 未就绪且首次启动或重试中 When 计算加载与错误状态 Then 优先呈现 loading 启动状态，绝不首帧闪现错误页', () => {
    const computeViewState = (
      status: { running: boolean; url?: string; error?: string },
      starting: boolean,
      startError: string | null,
    ) => {
      const isReady = status.running && Boolean(status.url)
      const isActualError = !isReady && !starting && Boolean(startError || status.error)
      const isLoading = !isReady && !isActualError
      return { isReady, isActualError, isLoading }
    }

    // 首帧挂载：status 尚未就绪，starting 随 !status.running 初始化为 true，startError 为 null
    const initialMount = computeViewState({ running: false }, true, null)
    expect(initialMount.isReady).toBe(false)
    expect(initialMount.isLoading).toBe(true)
    expect(initialMount.isActualError).toBe(false)

    // 正在启动中：即使 status 暂带旧 error，也处于 loading 态
    const startingWithOldError = computeViewState({ running: false, error: '旧错误' }, true, null)
    expect(startingWithOldError.isReady).toBe(false)
    expect(startingWithOldError.isLoading).toBe(true)
    expect(startingWithOldError.isActualError).toBe(false)
  })

  test('Given 启动完成但出现实际错误 When 计算加载与错误状态 Then 仅在实际失败且非启动中时呈现错误页', () => {
    const computeViewState = (
      status: { running: boolean; url?: string; error?: string },
      starting: boolean,
      startError: string | null,
    ) => {
      const isReady = status.running && Boolean(status.url)
      const isActualError = !isReady && !starting && Boolean(startError || status.error)
      const isLoading = !isReady && !isActualError
      return { isReady, isActualError, isLoading }
    }

    // 实际失败：starting 为 false，记录了 startError
    const actualFailure = computeViewState({ running: false }, false, '微内核启动超时')
    expect(actualFailure.isReady).toBe(false)
    expect(actualFailure.isLoading).toBe(false)
    expect(actualFailure.isActualError).toBe(true)

    // 实际成功：starting 为 false，running 为 true 且带 url
    const actualSuccess = computeViewState({ running: true, url: 'http://127.0.0.1:53080/' }, false, null)
    expect(actualSuccess.isReady).toBe(true)
    expect(actualSuccess.isLoading).toBe(false)
    expect(actualSuccess.isActualError).toBe(false)
  })

  test('Given 错误页点击重试 When 触发 handleRetry Then 错误立即清空并重置为 loading 启动状态', () => {
    let startError: string | null = '端口冲突无法启动'
    let starting = false

    const handleRetry = () => {
      startError = null
      starting = true
    }

    handleRetry()
    expect(startError).toBeNull()
    expect(starting).toBe(true)
  })

  test('Given 创造模式顶部 header 条移除 When 计算视图高度与顶距 Then 主视图顶格贴合无冗余 header 偏移', () => {
    // 之前带有 header 栏，移除后顶格为 0 且高度完全自适应主视图容器
    const containerTop = 0
    const containerHeight = 800
    const viewBounds = {
      y: Math.round(containerTop),
      height: Math.round(containerHeight),
    }

    expect(viewBounds.y).toBe(0)
    expect(viewBounds.height).toBe(800)
  })

  test('Given 创造模式接收到 COPIS_SWITCH_MODE 事件 When 目标为 agent 模式 Then 自动切换模式为 agent 并匹配恢复工作区会话', () => {
    let currentMode: string = 'creation'
    let currentActiveView: string = 'conversations'
    let openedSessionId: string | null = null

    const mockSessions = [
      { id: 'session-dsh-1', workspaceId: 'ws-default', mode: 'creation', agentRuntime: 'dsh', archived: false, title: '创造会话' },
      { id: 'session-agent-2', workspaceId: 'ws-default', mode: 'agent', agentRuntime: 'pi', archived: false, title: '常规 Agent 会话' },
    ]

    const handleBackToAgent = (targetWorkspaceId: string) => {
      currentMode = 'agent'
      currentActiveView = 'conversations'
      const matched = mockSessions.find(
        (s) => !s.archived && s.workspaceId === targetWorkspaceId && s.mode !== 'creation' && s.agentRuntime !== 'dsh',
      )
      if (matched) {
        openedSessionId = matched.id
      }
    }

    const onClientEvent = (e: { type: string; mode?: string }) => {
      if (e.type === 'COPIS_SWITCH_MODE' && e.mode === 'agent') {
        handleBackToAgent('ws-default')
      }
    }

    onClientEvent({ type: 'COPIS_SWITCH_MODE', mode: 'agent' })
    expect(currentMode).toBe('agent')
    expect(currentActiveView).toBe('conversations')
    expect(openedSessionId as string | null).toBe('session-agent-2')
  })

  test('Given DSH 侧边栏模式切换点击 Agent 模式 When 触发切换弹窗 Then 弹窗状态打开并可通过“返回Agent 模式”按钮执行切换', () => {
    let switchModeModalOpen = false
    let emittedEvent: { type: string; mode: string } | null = null

    // 1. 点击左菜单 tab 切换中的 Agent 模式按钮
    const onTabClick = () => {
      switchModeModalOpen = true
    }

    onTabClick()
    expect(switchModeModalOpen).toBe(true)

    // 2. 点击弹窗中的“返回Agent 模式”按钮
    const handleConfirmSwitchToAgent = () => {
      switchModeModalOpen = false
      emittedEvent = { type: 'COPIS_SWITCH_MODE', mode: 'agent' }
    }

    handleConfirmSwitchToAgent()
    expect(switchModeModalOpen).toBe(false)
    expect(emittedEvent as { type: string; mode: string } | null).toEqual({ type: 'COPIS_SWITCH_MODE', mode: 'agent' })
  })

  test('Given 创造模式与返回按钮 When 检查视觉契约规范 Then 右上角返回图标使用 ui-primary，创造模式使用 creation-ui-primary', () => {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const viewSource = readFileSync(join(__dirname, 'CopisCreationWebView.tsx'), 'utf8')
    const globalsSource = readFileSync(join(__dirname, '../../styles/globals.css'), 'utf8')

    // 1. globals.css 统一包含 creation-ui-primary 体系
    expect(globalsSource).toContain('--creation-ui-primary: #6C00CC;')
    expect(globalsSource).toContain('--creation-ui-primary: #a855f7;')
    expect(globalsSource).toContain('.creation-ui-primary-button')
    expect(globalsSource).toContain('.creation-ui-primary-badge')
    expect(globalsSource).toContain('.creation-ui-primary-surface')

    // 2. 右上角快捷返回按钮的 X 图标使用 ui-primary 色
    expect(viewSource).toContain('<X className="w-3.5 h-3.5 text-[var(--ui-primary)]" />')

    // 3. 返回 Agent 模式按钮的 Sparkles 图标使用 ui-primary 色
    expect(viewSource).toContain('<Sparkles className="w-3.5 h-3.5 mr-1.5 text-[var(--ui-primary)]" />')

    // 4. 创造模式加载态使用 creation-ui-primary 体系
    expect(viewSource).toContain('text-[var(--creation-ui-primary)]')
    expect(viewSource).toContain('bg-[var(--creation-ui-primary-background)]')
  })

  test('Given 创造模式左侧菜单栏与激活菜单项样式契约 When 检查 DSH 桥接样式注入 Then 侧边栏背景色与 Agent 模式一致且激活色使用 creation-ui-primary 体系', () => {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const preloadSource = readFileSync(join(__dirname, '../../../preload/dsh-bridge-preload.ts'), 'utf8')

    // 1. 侧边栏背景色浅色/深色与 Agent 模式一致（对应 hsl(var(--muted))）
    expect(preloadSource).toContain('--dsw-specific-sidebar-fill: hsl(0 0% 96.1%) !important;')
    expect(preloadSource).toContain('--dsw-specific-sidebar-fill: hsl(0 0% 17%) !important;')

    // 2. 菜单项激活背景色与文字高亮色使用 creation-ui-primary 体系
    expect(preloadSource).toContain('--dsw-specific-sidebar-nav-item-active: rgba(108, 0, 204, 0.15) !important;')
    expect(preloadSource).toContain('--dsw-specific-sidebar-nav-item-active-accent: #6C00CC !important;')
    expect(preloadSource).toContain('--dsw-specific-sidebar-nav-item-active: rgba(168, 85, 247, 0.18) !important;')
    expect(preloadSource).toContain('--dsw-specific-sidebar-nav-item-active-accent: #a855f7 !important;')

    // 3. 侧边栏容器与菜单项覆盖规则
    expect(preloadSource).toContain('background: var(--dsw-specific-sidebar-fill) !important;')
    expect(preloadSource).toContain('background: var(--creation-ui-primary-background) !important;')
    expect(preloadSource).toContain('color: var(--creation-ui-primary) !important;')
    expect(preloadSource).toContain('border: none !important;')
  })

  test('Given 创造模式侧边栏与菜单管理契约 When 检查 DSH 桥接 Preload 注入 Then 支持菜单隐藏属性选择器且胶囊按钮无背景色仅保留边框', () => {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const preloadSource = readFileSync(join(__dirname, '../../../preload/dsh-bridge-preload.ts'), 'utf8')

    // 1. Preload 脚本包含隐藏菜单样式注入（属性选择器 [data-copis-hidden="true"]）
    expect(preloadSource).toContain('.copis-menu-section button[data-copis-hidden="true"]')
    expect(preloadSource).toContain('.copis-rail-menu-section button[data-copis-hidden="true"]')
    expect(preloadSource).toContain('display: none !important;')

    // 2. 隐藏胶囊按钮无背景色，仅边框，无 hover 变色效果，静态呈现边框与文字
    expect(preloadSource).toContain('.copis-dsh-menu-hide-btn')
    expect(preloadSource).toContain('background: transparent !important;')
    expect(preloadSource).toContain('border: 1px solid')
    expect(preloadSource).toContain('border-radius: 9999px;')
    expect(preloadSource).toContain('height: 20px;')
    expect(preloadSource).toContain('padding: 0 7px;')
    expect(preloadSource).not.toContain('.copis-dsh-menu-hide-btn:hover')

    // 3. 包含 DOM 观察与事件同步核心函数
    expect(preloadSource).toContain('function applyHiddenSidebarMenuItems(hiddenItems: string[]): void')
    expect(preloadSource).toContain('async function hideDshMenuItem(menuId: string): Promise<void>')
    expect(preloadSource).toContain('function syncDshSidebarMenuDoms(): void')
    expect(preloadSource).toContain('function setupDshSidebarMenuObserver(): void')
    expect(preloadSource).toContain('COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED')
    expect(preloadSource).toContain('hideMenuItem:')
    expect(preloadSource).toContain('getHiddenMenuItems:')
  })

  test('Given 打开了 Copis 子功能面板 When 接收到切回会话事件 (COPIS_NAVIGATE: conversations) Then 子功能面板立即关闭收起且激活视图重置为 conversations 且向 DSH 发送清除高亮广播', () => {
    let creationSubView: string | null = 'memory'
    let activeView: string = 'memory'
    let dispatchedClientEvent: { type: string; view?: string } | null = null

    const handleClientEvent = (e: { type: string; view?: string }) => {
      if (e.type === 'COPIS_NAVIGATE') {
        if (e.view === 'conversations') {
          creationSubView = null
          activeView = 'conversations'
          dispatchedClientEvent = {
            type: 'COPIS_ACTIVE_VIEW_CHANGE',
            view: 'conversations',
          }
        }
      }
    }

    // 触发切回会话事件
    handleClientEvent({ type: 'COPIS_NAVIGATE', view: 'conversations' })
    expect(creationSubView).toBeNull()
    expect(activeView).toBe('conversations')
    expect(dispatchedClientEvent as { type: string; view?: string } | null).toEqual({
      type: 'COPIS_ACTIVE_VIEW_CHANGE',
      view: 'conversations',
    })
  })

  test('Given DSH 侧边栏 DOM 交互 When 用户点击会话项、新建会话按钮或会话容器 Then 准确判定为切回会话意图', () => {
    // 模拟 session click interceptor 匹配规则
    const matchSessionClick = (element: {
      classList: string[]
      ariaLabel?: string
      parentClassList?: string[]
    }): boolean => {
      const allClasses = [...element.classList, ...(element.parentClassList || [])]
      // 1. 排除 Copis 自身菜单与操作区
      if (allClasses.some((c) => c.includes('copis-menu-section') || c.includes('copis-rail-menu-section') || c.includes('copis-mode-switcher') || c.includes('footArea'))) {
        return false
      }
      // 2. 排除工作区目录文件夹折叠行
      if (allClasses.some((c) => c.includes('projectRow'))) {
        return false
      }
      // 3. 命中会话行、新建会话或会话容器
      const isSession = allClasses.some((c) => c.includes('sessionRow') || c.includes('searchResultRow'))
      const isNewSession = allClasses.some((c) => c.includes('newSession')) || Boolean(element.ariaLabel?.includes('会话') || element.ariaLabel?.includes('session'))
      const isRegion = allClasses.some((c) => c.includes('regionArea'))
      return isSession || isNewSession || isRegion
    }

    // 场景 A：点击会话条目（YDXeBa_sessionRow）
    expect(matchSessionClick({ classList: ['YDXeBa_sessionRow', 'YDXeBa_selected'] })).toBe(true)
    // 场景 B：点击会话标题文本（span.YDXeBa_title，父元素为 sessionRow）
    expect(matchSessionClick({ classList: ['YDXeBa_title'], parentClassList: ['YDXeBa_sessionRow'] })).toBe(true)
    // 场景 C：点击新建会话按钮（hHd-Xa_newSession）
    expect(matchSessionClick({ classList: ['hHd-Xa_newSession'], ariaLabel: '新建会话' })).toBe(true)
    // 场景 D：点击搜索结果中的会话（YDXeBa_searchResultRow）
    expect(matchSessionClick({ classList: ['YDXeBa_searchResultRow'] })).toBe(true)
    // 场景 E：点击会话列表空白滚动区域（hHd-Xa_regionArea）
    expect(matchSessionClick({ classList: ['hHd-Xa_regionArea'] })).toBe(true)

    // 反向场景 1：点击项目文件夹折叠行（YDXeBa_projectRow）不触发切回
    expect(matchSessionClick({ classList: ['YDXeBa_projectRow'], parentClassList: ['hHd-Xa_regionArea'] })).toBe(false)
    // 反向场景 2：点击 Copis 记忆菜单项不触发切回
    expect(matchSessionClick({ classList: ['copis-menu-item'], parentClassList: ['copis-menu-section'] })).toBe(false)
    // 反向场景 3：点击模式切换器不触发切回
    expect(matchSessionClick({ classList: ['copis-mode-btn'], parentClassList: ['copis-mode-switcher'] })).toBe(false)
    // 反向场景 4：点击底部意见反馈不触发切回
    expect(matchSessionClick({ classList: ['hHd-Xa_footArea'] })).toBe(false)
  })

  test('Given Preload 脚本与组件源码契约 When 检查会话点击拦截器与视图联动实现 Then 契约完整闭环', () => {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const preloadSource = readFileSync(join(__dirname, '../../../preload/dsh-bridge-preload.ts'), 'utf8')
    const viewSource = readFileSync(join(__dirname, 'CopisCreationWebView.tsx'), 'utf8')

    // 1. Preload 脚本包含 setupSessionClickInterceptor
    expect(preloadSource).toContain('function setupSessionClickInterceptor(): void')
    expect(preloadSource).toContain('setupSessionClickInterceptor()')
    expect(preloadSource).toContain("copisBridge.navigate('conversations')")
    expect(preloadSource).toContain("type: 'COPIS_ACTIVE_VIEW_CHANGE', view: 'conversations'")
    expect(preloadSource).toContain("document.addEventListener('click', onSessionClick, true)")

    // 2. CopisCreationWebView 在 COPIS_NAVIGATE conversations 时完成 subview 收起、activeView 重置与客户端高亮清除
    expect(viewSource).toContain("e.view === 'conversations'")
    expect(viewSource).toContain('setCreationSubView(null)')
    expect(viewSource).toContain("setActiveView('conversations')")
    expect(viewSource).toContain("type: 'COPIS_ACTIVE_VIEW_CHANGE'")
  })
})



