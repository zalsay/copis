import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'client.tsx'), 'utf8')
const preloadSource = readFileSync(join(import.meta.dir, '../../../src/preload/dsh-bridge-preload.ts'), 'utf8')

test('Given macOS 创造模式侧栏 When 检查内置插件菜单 Then 功能入口文案和顺序与参考界面一致', () => {
  const labels = ['搜索', '日程表', '定时任务', '记忆', '知识库', '专家团队', '技能市场', '我的投资']
  let previousIndex = -1

  for (const label of labels) {
    const index = source.indexOf(`label: '${label}'`)
    expect(index).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
})

test('Given DSH 0.1.2 与 0.1.3 侧栏 When 插件挂载 Then 菜单使用稳定锚点进入原生工作区前的正确位置', () => {
  expect(source).not.toContain('before-new-session')
  expect(source).toContain('button[class*="_newSession"], button[class*="newSession"]')
  expect(source).toContain('[class*="_regionArea"], [class*="regionArea"]')
  expect(source).toContain('sidebar.insertBefore(element, target)')
  expect(source).toContain("sidebar.classList.add('copis-creation-sidebar')")
  expect(source).not.toContain("ctx.slots.inject('sidebar.brand.mark'")
  expect(source).not.toContain("ctx.slots.inject('conversation.composer.dock'")
})

test('Given 用户位于创造模式 When 操作搜索和设置 Then 事件进入 Copis 桥而非 DSH 默认页面', () => {
  expect(source).toContain('window.copisBridge.openSearch()')
  expect(source).toContain("sendNavigation('settings')")
  expect(source).toContain('event.stopImmediatePropagation()')
})

test('Given 创造模式左栏 When 插件加载 Then 不渲染模式切换器且隐藏 DSH 本地构建 Header', () => {
  expect(source).not.toContain('ModeSwitcher')
  expect(source).not.toContain('copis-mode-switcher')
  expect(source).not.toContain('sendModeSwitch')
  expect(source).toContain('[class*="_logoRow"]')
  expect(source).toContain('[class*="_localBuildBrand"]')
  expect(preloadSource).toContain('[class*="_logoRow"]')
  expect(preloadSource).toContain('[class*="_localBuildBrand"]')
})

test('Given 创造模式宽侧栏菜单 When 悬停显示隐藏按钮 Then 菜单标签占据剩余宽度且按钮贴右对齐', () => {
  expect(source).toContain('.copis-menu-item > span')
  expect(source).toContain('.copis-menu-item > .copis-dsh-menu-hide-btn')
  expect(source).toContain('flex: 1;')
  expect(source).toContain('position: static !important;')
  expect(source).toContain('margin-left: auto;')
  expect(preloadSource).toContain('position: static !important;')
  expect(preloadSource).toContain('margin-left: auto;')
  expect(preloadSource).toContain('flex: none;')
})

test('Given 创造模式侧栏菜单图标与隐藏机制 When 检查源码 Then 对齐 CalendarClock 与 Puzzle 且支持菜单隐藏持久化', () => {
  expect(source).toContain('CalendarClock')
  expect(source).toContain('Puzzle')
  expect(source).not.toContain('CalendarDays')
  expect(source).not.toContain('Blocks')
  expect(source).toContain('COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED')
  expect(source).toContain('window.copisBridge?.hideMenuItem')
  expect(source).toContain('window.copisBridge?.getHiddenMenuItems')
  expect(source).toContain('data-copis-menu-id')
})

test('Given 创造模式中部对话区右上角 When 插件加载 Then 注入返回 Agent 模式与工作区文件展开按钮且支持模式切换', () => {
  // 1. 注入到会话右上角 utilities 插槽
  expect(source).toContain("ctx.slots.inject('conversation.session.header.utilities'")
  expect(source).toContain("name: 'conversation.session.header.utilities'")
  expect(source).toContain('CopisHeaderUtilities')

  // 2. 具备返回 Agent 模式按钮及交互（使用统一的 CopisLogoIcon 双环矢量图标）
  expect(source).toContain('handleSwitchToAgent')
  expect(source).toContain("window.copisBridge.switchMode('agent')")
  expect(source).toContain("type: 'COPIS_SWITCH_MODE', mode: 'agent'")
  expect(source).toContain('切换回 Agent 模式')
  expect(source).toContain('Agent 模式')
  expect(source).toContain('CopisLogoIcon')
  expect(source).not.toContain('<Sparkles')

  // 3. 具备工作区文件展开/折叠按钮（与 Agent 模式对齐，单个 icon 图标控制，无多余文字标签）
  expect(source).toContain('handleToggleWorkspaceDetails')
  expect(source).toContain('props.ctx.layout?.openDetails()')
  expect(source).toContain('props.ctx.layout?.closeDetails()')
  expect(source).toContain('PanelRight')
  expect(source).toContain('PanelRightClose')
  expect(source).not.toContain('<span>工作区</span>')
})

test('Given 创造模式右侧详情区 When 插件加载 Then 不重复注入 details 插槽避免冲突且具备独立面板能力', () => {
  // 1. 不重复注册 details 插槽，交由官方 Chat DetailsPanel 承载，避免 single slot priority 冲突
  expect(source).not.toContain("ctx.slots.inject('details'")
  expect(source).toContain('CopisDetailsPanel')

  // 2. 具备工作区根目录读取与子目录按需异步加载
  expect(source).toContain('listDirectory(undefined, sessionCwd)')
  expect(source).toContain('listDirectory(folderPath, sessionCwd)')
  expect(source).toContain('toggleFolder')
  expect(source).toContain('handleRefresh')

  // 3. 具备搜索过滤功能
  expect(source).toContain('filterText')
  expect(source).toContain('filteredFiles')

  // 4. 具备文件原地预览（文本/代码高亮与图片渲染）及系统定位
  expect(source).toContain('openPreview')
  expect(source).toContain('readFile(file.path, sessionCwd)')
  expect(source).toContain('handleLocateFile')
  expect(source).toContain('showItemInFolder(filePath, sessionCwd)')
  expect(source).toContain('handleCopyContent')
  expect(source).toContain('previewState.isImage')
})

test('Given 创造模式全局根层 When 插件加载 Then 注入 shell.overlay 承载欢迎页常驻操作栏与全局工作区文件抽屉', () => {
  expect(source).toContain("ctx.slots.inject('shell.overlay'")
  expect(source).toContain("name: 'shell.overlay'")
  expect(source).toContain('CopisShellOverlayManager')
  expect(source).toContain('copis-hero-utilities-overlay')
  expect(source).toContain('copis-details-drawer-root')
  expect(source).toContain('copis-details-drawer-backdrop')
  expect(source).toContain('COPIS_TOGGLE_WORKSPACE_DRAWER')
})

test('Given 创造模式激活子功能视图 When 渲染左侧导航与计算展开状态 Then 保持宽态菜单且调用 toggleSidebar 展开 DSH 侧边栏', () => {
  // 1. wide 计算保证子视图激活时强制为 true，绝不回退为窄 rail
  expect(source).toContain('const isSubviewActive = activeView !== \'conversations\'')
  expect(source).toContain('isSubviewActive ||')
  expect(source).toContain('Boolean(props.wide)')

  // 2. 具备自动检测折叠并调用 ctx.layout.toggleSidebar() 的联动机制
  expect(source).toContain('effectiveCtx?.layout?.toggleSidebar')
  expect(source).toContain('data-sidebar-collapsed')
  expect(source).toContain('hHd-Xa_collapsed')

  // 3. CSS 不再粗暴对 copis-rail-menu-section 设置 display: none !important 导致菜单丢失
  expect(source).not.toContain('body.copis-subview-active .copis-rail-menu-section')
  expect(preloadSource).not.toContain('body.copis-subview-active .copis-rail-menu-section')
})

test('Given 创造模式激活子功能视图 When 检查新会话按钮切换契约 Then 客户端插件包含返回会话样式注入、Esc 提示与点击拦截', () => {
  // 1. 样式规则：子功能激活时，button._newSession 变为返回会话样式，并注入返回箭头与「返回会话」文本
  expect(source).toContain('body.copis-subview-active button[class*="_newSession"]')
  expect(source).toContain('content: "返回会话"')
  expect(source).toContain('content: "Esc"')
  expect(source).toContain('--creation-ui-primary-background')
  expect(source).toContain('body.copis-subview-active .copis-hero-utilities-overlay')

  // 2. 点击拦截：顶部按钮在 subview 激活时阻止 DSH startSession 并通知主程序关闭子视图
  expect(source).toContain('handleTopButtonClick')
  expect(source).toContain('event.stopImmediatePropagation()')
  expect(source).toContain("sendNavigation('conversations')")
  expect(source).toContain('data-copis-return-button')

  // 3. 语义提示同步：更新 title 和 aria-label 为 '返回会话 (Esc)'
  expect(source).toContain("topBtn.setAttribute('title', '返回会话 (Esc)')")
  expect(source).toContain("topBtn.setAttribute('aria-label', '返回会话 (Esc)')")
})

test('Given 创造模式侧栏底部设置入口 When 用户点击设置 Then 拦截 DSH 原生设置并进入 Copis 全屏设置', () => {
  // 1. client.tsx 与 preload 均包含 DSH 原生设置弹窗屏蔽规则
  expect(source).toContain('[class*="VOzbGW_panel"]')
  expect(source).toContain('[class*="VOzbGW_overlay"]')
  expect(source).toContain('[class*="VOzbGW_mask"]')
  expect(preloadSource).toContain('[class*="VOzbGW_panel"]')
  expect(preloadSource).toContain('[class*="VOzbGW_overlay"]')
  expect(preloadSource).toContain('[class*="VOzbGW_mask"]')

  // 2. 具备精确判定 DSH 设置按钮并全局捕获拦截的机制
  expect(source).toContain('isSettingsTarget')
  expect(source).toContain('settingsArea')
  expect(source).toContain('triggerRow')
  expect(source).toContain("setActiveView('settings')")
  expect(source).toContain("sendNavigation('settings')")
  expect(source).toContain('window.copisBridge?.openSettings')
  expect(preloadSource).toContain('setupSettingsClickInterceptor')
  expect(preloadSource).toContain('copisBridge.openSettings()')
})

test('Given 创造模式与 Agent 模式视觉对齐契约 When 检查菜单栏与右上角按钮 Then 文字大小14px、圆角7px、动态主题色绑定完全对齐', () => {
  // 1. 宽侧栏菜单项对齐 Agent 模式：font-size: 14px; border-radius: 7px; min-height: 31px;
  expect(source).toContain('font-size: 14px;')
  expect(source).toContain('border-radius: 7px;')
  expect(source).toContain('min-height: 31px;')
  expect(source).toContain('line-height: 1.25;')
  expect(preloadSource).toContain('.copis-menu-item')
  expect(preloadSource).toContain('font-size: 14px !important;')
  expect(preloadSource).toContain('border-radius: 7px !important;')

  // 2. 窄栏菜单项对齐：width: 28px; height: 28px; border-radius: 7px;
  expect(source).toContain('.copis-rail-menu-item')
  expect(source).toContain('width: 28px;')
  expect(source).toContain('height: 28px;')
  expect(preloadSource).toContain('.copis-rail-menu-item')

  // 3. 右上角操作按钮（Agent 模式、工作区等）对齐：border-radius: 7px; 工作区为 30px 方形单图标按钮
  expect(source).toContain('.copis-header-action-btn')
  expect(source).toContain('.copis-header-btn-agent')
  expect(source).toContain('.copis-header-btn-workspace')
  expect(source).toContain('width: 30px !important;')
  expect(source).toContain('height: 30px !important;')
  expect(source).toContain('border-radius: 7px !important;')
  expect(source).toContain('var(--ui-primary')
  expect(source).toContain('var(--ui-primary-background')
  expect(preloadSource).toContain('.copis-header-btn-agent')
  expect(preloadSource).toContain('.copis-header-btn-workspace')
  expect(preloadSource).toContain('width: 30px !important;')

  // 4. 新建会话按钮与会话行对齐：border-radius: 7px; font-size: 14px;
  expect(source).toContain('button[class*="_newSession"]')
  expect(source).toContain('[class*="sessionRow"]')
  expect(preloadSource).toContain('button[class*="_newSession"]')
  expect(preloadSource).toContain('.YDXeBa_sessionRow')
})

test('Given 创造模式内建搜索浮层 When 检查组件与样式契约 Then 具备独立浮层与半透明遮罩避免背景白屏', () => {
  // 1. 包含 CopisSearchModal 并在 shell.overlay 中注册
  expect(source).toContain('CopisSearchModal')
  expect(source).toContain('COPIS_OPEN_SEARCH_MODAL')

  // 2. 具备半透明遮罩与弹窗居中规范，确保底层 DSH 界面可见
  expect(source).toContain('.copis-search-modal-backdrop')
  expect(source).toContain('.copis-search-modal-card')
  expect(source).toContain('background: rgba(0, 0, 0, 0.45);')
  expect(source).toContain('backdrop-filter: blur(2px);')

  // 3. 支持关键词输入、会话匹配、消息全文检索与高亮
  expect(source).toContain('HighlightSearchText')
  expect(source).toContain('getAgentSessions')
  expect(source).toContain('searchAgentSessionMessages')
  expect(source).toContain('navigateToResult')

  // 4. 支持快捷键（Enter 搜索/打开，Esc 关闭，Arrow 导航，Cmd/Ctrl+K 唤起）
  expect(source).toContain("e.key.toLowerCase() === 'k'")
  expect(source).toContain("e.key === 'Escape'")
  expect(source).toContain("e.key === 'ArrowDown'")
  expect(source).toContain("e.key === 'ArrowUp'")
})

