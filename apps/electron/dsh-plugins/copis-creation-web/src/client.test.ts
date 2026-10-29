import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'client.tsx'), 'utf8')
const preloadSource = readFileSync(join(import.meta.dir, '../../../src/preload/dsh-bridge-preload.ts'), 'utf8')
const filesTabSource = readFileSync(join(import.meta.dir, 'inspector/FilesInspectorTab.tsx'), 'utf8')
const sideChatTabSource = readFileSync(join(import.meta.dir, 'inspector/SideChatInspectorTab.tsx'), 'utf8')
const teamTabSource = readFileSync(join(import.meta.dir, 'inspector/TeamInspectorTab.tsx'), 'utf8')
const inspectorPanelSource = readFileSync(join(import.meta.dir, 'inspector/CopisInspectorPanel.tsx'), 'utf8')

test('Given macOS 创造模式侧栏 When 检查内置插件菜单 Then 功能入口文案和顺序与参考界面一致', () => {
  const labels = ['搜索', '日程表', '定时任务', '记忆', '知识库', '专家团队', '群聊协作', '技能市场', '我的投资']
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

test('Given 创造模式左侧菜单栏 When 检查样式与 DOM 契约 Then 包含隐藏旧版未带 data-copis-placement 的静态菜单与自动清理旧节点逻辑避免菜单重复', () => {
  expect(source).toContain('.copis-menu-section:not([data-copis-placement="before-workspaces"])')
  expect(source).toContain('.copis-rail-menu-section:not([data-copis-placement="before-workspaces"])')
  expect(source).toContain('display: none !important;')
  expect(source).toContain('legacySections.forEach((el) => el.remove())')
  expect(preloadSource).toContain('.copis-menu-section:not([data-copis-placement="before-workspaces"])')
  expect(preloadSource).toContain('.copis-rail-menu-section:not([data-copis-placement="before-workspaces"])')
  expect(preloadSource).toContain('legacySections.forEach((el) => el.remove())')
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

test('Given 创造模式中部对话区右上角 When 插件加载 Then 右上角移除 Agent 模式按钮并仅保留工作区文件展开按钮', () => {
  // 1. 注入到会话右上角 utilities 插槽
  expect(source).toContain("ctx.slots.inject('conversation.session.header.utilities'")
  expect(source).toContain("name: 'conversation.session.header.utilities'")
  expect(source).toContain('CopisHeaderUtilities')

  // 2. 彻底移除右上角 Agent 模式按钮（包括自定义与官方 session-log-download）
  expect(source).not.toContain('handleSwitchToAgent')
  expect(source).not.toContain('切换回 Agent 模式')
  expect(source).not.toContain('<span>Agent 模式</span>')
  expect(source).toContain('button[class*="sessionLogButton"]')
  expect(source).toContain('button[title*="返回 Agent 模式"]')
  expect(preloadSource).toContain('button[class*="sessionLogButton"]')
  expect(preloadSource).toContain('button[title*="返回 Agent 模式"]')

  // 3. 具备工作区文件展开/折叠按钮（与 Agent 模式对齐，单个 icon 图标控制，统一唤起宽幅多页签抽屉）
  expect(source).toContain('handleToggleWorkspaceDetails')
  expect(source).toContain('COPIS_TOGGLE_WORKSPACE_DRAWER')
  expect(source).toContain('props.ctx.layout?.closeDetails()')
  expect(source).toContain('PanelRight')
  expect(source).toContain('PanelRightClose')
  expect(source).not.toContain('<span>工作区</span>')
})

test('Given 创造模式右侧详情区 When 插件加载 Then 具备多页签 Inspector 系统且文件面板支持异步浏览与高亮预览', () => {
  // 1. 不重复注册 details 插槽避免 single slot priority 冲突，导出并兼容 CopisInspectorPanel / CopisDetailsPanel
  expect(source).not.toContain("ctx.slots.inject('details'")
  expect(source).toContain('CopisDetailsPanel')
  expect(source).toContain('CopisInspectorPanel')

  // 2. FilesInspectorTab 具备工作区根目录读取与子目录按需异步加载
  expect(filesTabSource).toContain('listDirectory(undefined, sessionCwd)')
  expect(filesTabSource).toContain('listDirectory(folderPath, sessionCwd)')
  expect(filesTabSource).toContain('toggleFolder')
  expect(filesTabSource).toContain('handleRefresh')

  // 3. 具备文件名搜索过滤功能
  expect(filesTabSource).toContain('filterText')
  expect(filesTabSource).toContain('filteredFiles')

  // 4. 具备文件原地预览（代码高亮与图片渲染）、复制内容及系统定位
  expect(filesTabSource).toContain('openPreview')
  expect(filesTabSource).toContain('readFile(file.path, sessionCwd)')
  expect(filesTabSource).toContain('handleLocateFile')
  expect(filesTabSource).toContain('showItemInFolder(filePath, sessionCwd)')
  expect(filesTabSource).toContain('handleCopyContent')
  expect(filesTabSource).toContain('previewState.isImage')
})

test('Given 创造模式全局根层 When 插件加载 Then 侧边栏为推入式抽屉并列排布且严禁渲染遮罩覆盖聊天区', () => {
  // 1. 在 shell.overlay 注入常驻操作栏与推入式抽屉管理器
  expect(source).toContain("ctx.slots.inject('shell.overlay'")
  expect(source).toContain("name: 'shell.overlay'")
  expect(source).toContain('CopisShellOverlayManager')
  expect(source).toContain('copis-hero-utilities-overlay')
  expect(source).toContain('copis-details-drawer-root')
  expect(source).toContain('COPIS_TOGGLE_WORKSPACE_DRAWER')

  // 2. 彻底移除全屏遮罩，严禁覆盖聊天区导致无法交互
  expect(source).not.toContain('copis-details-drawer-backdrop')

  // 3. 抽屉展开时，中部聊天区通过 margin-right 响应推入并列布局
  expect(source).toContain('body.copis-details-drawer-open [class*="_centerCol"]')
  expect(source).toContain('margin-right: var(--copis-inspector-width')
  expect(source).toContain('transition: margin-right')

  // 4. 具备左边缘拖拽调整宽度手柄与尺寸记忆
  expect(source).toContain('copis-inspector-resize-handle')
  expect(source).toContain('handleResizeStart')
  expect(source).toContain('copis-inspector-resizing')

  // 5. 抽屉背景色为纯正灰色（深色 #18181b / 浅色 #f4f4f5），严禁在抽屉背景上混入紫色
  expect(source).toContain('.copis-details-drawer-root')
  expect(source).toContain('background: #18181b;')
  expect(source).toContain('body:not([data-ds-dark-theme]) .copis-details-drawer-root {\n    background: #f4f4f5;')
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

test('Given 创造模式 Composer 输入框胶囊 When 检查视觉契约 Then 采用紫色半透明毛玻璃背景配合微光边框与辉光阴影', () => {
  // 1. client.tsx 源码契约：覆盖 uV2eYG_card 与 composer 卡片，呈现背景更深、紫色更淡的毛玻璃质感
  expect(source).toContain('[class*="uV2eYG_card"]')
  expect(source).toContain('color-mix(in srgb, var(--creation-ui-primary')
  expect(source).toContain('backdrop-filter: blur(')
  expect(source).toContain('box-shadow:')

  // 2. preload 脚本契约：保持初始化即注入相同毛玻璃质感，避免闪烁
  expect(preloadSource).toContain('[class*="uV2eYG_card"]')
  expect(preloadSource).toContain('color-mix(in srgb, var(--creation-ui-primary')
  expect(preloadSource).toContain('backdrop-filter: blur(')
})

test('Given 创造模式侧栏菜单项 When 检查专家团队与群聊协作 Then 不包含 BETA 与 灵活 tag 徽标', () => {
  expect(source).toContain("id: 'expert-team', label: '专家团队', icon: UsersRound, view: 'expert-team'")
  expect(source).toContain("id: 'group-chat', label: '群聊协作', icon: UsersRound, view: 'group-chat'")
  expect(source).not.toContain("badge: 'BETA'")
  expect(source).not.toContain("badge: '灵活'")
})

test('Given 创造模式 Composer 内部按钮（如上下文用量圆环） When 执行 isSettingsTarget 判定 Then 严禁误判为设置入口', () => {
  // 1. client 源码契约：排除 composer 与 对话区按钮，限制必须在侧栏容器内
  expect(source).toContain('[class*="composer"]')
  expect(source).toContain('[class*="_centerCol"]')
  expect(source).toContain('inSidebar')

  // 2. preload 脚本契约：同步排除 composer 与 对话区按钮，限制必须在侧栏容器内
  expect(preloadSource).toContain('[class*="composer"]')
  expect(preloadSource).toContain('[class*="_centerCol"]')
  expect(preloadSource).toContain('inSidebar')
})

test('Given 创造模式 Composer 圆环与视口 When 悬浮弹出 Tooltip Then 包含横向滚动条抑制与 Tooltip 边界定位保护', () => {
  // 1. client.tsx 源码契约：overflow-x clip 与 webkit-scrollbar:horizontal 隐藏
  expect(source).toContain('overflow-x: clip !important;')
  expect(source).toContain('::-webkit-scrollbar:horizontal')
  expect(source).toContain('[class*="JObwrW_root"]')

  // 2. preload 脚本契约：保持初始化即注入横向滚动条抑制规则
  expect(preloadSource).toContain('overflow-x: clip !important;')
  expect(preloadSource).toContain('::-webkit-scrollbar:horizontal')
  expect(preloadSource).toContain('[class*="JObwrW_root"]')
})

test('Given 创造模式 Inspector 多页签系统 When 检查顶栏交互 Then 支持文件、侧边聊天、团队多页签切换且支持加号下拉菜单添加与关闭页签', () => {
  // 1. 具备默认三大页签配置
  expect(inspectorPanelSource).toContain("kind: 'files'")
  expect(inspectorPanelSource).toContain("label: '工作区文件'")
  expect(inspectorPanelSource).toContain("kind: 'side-chat'")
  expect(inspectorPanelSource).toContain("label: '侧边聊天'")
  expect(inspectorPanelSource).toContain("kind: 'team'")
  expect(inspectorPanelSource).toContain("label: '智能体团队'")

  // 2. 具备 Tab 切换、激活态与关闭逻辑
  expect(inspectorPanelSource).toContain('setActiveTabId')
  expect(inspectorPanelSource).toContain('handleCloseTab')

  // 3. 具备加号下拉菜单新建或重新打开页签
  expect(inspectorPanelSource).toContain('copis-inspector-add-dropdown')
  expect(inspectorPanelSource).toContain('handleAddTab')
  expect(inspectorPanelSource).toContain('新建侧边聊天')

  // 4. 具备工作区抽屉容器类名
  expect(source).toContain('copis-inspector-root')
  expect(source).toContain('copis-inspector-tabbar')

  // 5. 侧栏上方 Tab 激活时，Icon 使用紫色高亮
  expect(inspectorPanelSource).toContain("activePurple = '#a855f7'")
  expect(inspectorPanelSource).toContain('isActive ? activePurple :')
  expect(source).toContain('.copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon')
  expect(source).toContain('color: #a855f7 !important;')
})

test('Given 创造模式侧边聊天 (Side Chat) 检查器 When 检查轻量问答能力 Then 包含上下文对话流、预设推荐快捷提问与首条消息自动更新页签标题', () => {
  // 1. 具备消息流与发送能力
  expect(sideChatTabSource).toContain('handleSend')
  expect(sideChatTabSource).toContain('copis-inspector-sidechat-messages')
  expect(sideChatTabSource).toContain('copis-sidechat-bubble')

  // 2. 首条消息动态更新 Tab 标题
  expect(sideChatTabSource).toContain('onTitleChange')

  // 3. 具备预设快捷推荐 Chips
  expect(sideChatTabSource).toContain('PRESET_PROMPTS')
  expect(sideChatTabSource).toContain('copis-sidechat-preset-chips')

  // 4. 具备清空历史会话能力
  expect(sideChatTabSource).toContain('handleClear')
})

test('Given 创造模式智能体团队 (Team) 检查器 When 检查协同与任务编排 Then 展示成员状态、任务依赖状态与历史会话回溯', () => {
  // 1. 团队成员列表与状态指示
  expect(teamTabSource).toContain('copis-team-member-item')
  expect(teamTabSource).toContain('copis-team-status-chip')
  expect(teamTabSource).toContain('协同成员')
  expect(teamTabSource).toContain('创造模式主智能体')

  // 2. 任务编排看板与依赖展示
  expect(teamTabSource).toContain('copis-team-task-item')
  expect(teamTabSource).toContain('任务编排')
  expect(teamTabSource).toContain('blockedBy')
  expect(teamTabSource).toContain('writeScopes')

  // 3. 历史子智能体会话回溯视图与返回
  expect(teamTabSource).toContain('copis-inspector-subagent-view')
  expect(teamTabSource).toContain('返回团队看板')
  expect(teamTabSource).toContain('copis-team-subagent-log-box')
})

test('Given 创造模式工作区文件检查器 When 解析当前会话与工作区 CWD Then 包含响应式订阅、多源 fallback 与零短路加载', () => {
  // 1. client.tsx 声明注入 workspaces 服务，并声明 getActiveWorkspacePath bridge 接口
  expect(source).toContain("export const inject = ['slots', 'layout', 'sessions', 'workspaces']")
  expect(source).toContain('getActiveWorkspacePath?: (cwd?: string) => Promise<string>')
  expect(preloadSource).toContain('getActiveWorkspacePath: (cwd?: string) => {')

  // 2. CopisInspectorPanel 实现 resolveInspectorSessionCwd 并覆盖 items 与 workspaces 多源 fallback
  expect(inspectorPanelSource).toContain('resolveInspectorSessionCwd')
  expect(inspectorPanelSource).toContain('listSnapshot?.items')
  expect(inspectorPanelSource).toContain('ctx?.workspaces?.getSnapshot')
  expect(inspectorPanelSource).toContain('props.ctx?.sessions?.list?.subscribe')
  expect(inspectorPanelSource).toContain('props.ctx?.workspaces?.subscribe')
  expect(inspectorPanelSource).toContain('window.copisBridge?.getActiveWorkspacePath')

  // 3. FilesInspectorTab 彻底移除 if (!sessionCwd) return 致命短路，确保初次挂载时立即调用目录扫描
  expect(filesTabSource).not.toContain('if (!sessionCwd) return')
  expect(filesTabSource).toContain('.listDirectory(undefined, sessionCwd)')
  expect(filesTabSource).toContain('重新扫描')
})



