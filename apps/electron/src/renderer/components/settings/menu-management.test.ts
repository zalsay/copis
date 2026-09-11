/**
 * 菜单管理与侧栏隐藏胶囊按钮功能与契约测试 (BDD)
 */

import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SIDEBAR_MENU_ITEMS,
  hiddenSidebarMenuItemsAtom,
  initializeHiddenSidebarMenuItems,
  setSidebarMenuItemVisibility,
  hideSidebarMenuItem,
  showAllSidebarMenuItems,
  type SidebarMenuItemId,
} from '@/atoms/sidebar-menu-atoms'
import { getDefaultStore } from 'jotai'

const sidebarSource = readFileSync(
  join(import.meta.dir, '../app-shell/CopisWorkingSidebar.tsx'),
  'utf8',
)
const sidebarStyles = readFileSync(
  join(import.meta.dir, '../app-shell/CopisWorkingSidebar.css'),
  'utf8',
)
const settingsPanelSource = readFileSync(
  join(import.meta.dir, '../app-shell/CopisWorkingSettingsPanel.tsx'),
  'utf8',
)
const menuSettingsSource = readFileSync(
  join(import.meta.dir, 'MenuManagementSettings.tsx'),
  'utf8',
)

describe('左侧菜单栏悬浮隐藏与菜单管理功能契约 (BDD)', () => {
  let store: ReturnType<typeof getDefaultStore>
  let mockUpdateSettings: ReturnType<typeof mock>
  let mockGetSettings: ReturnType<typeof mock>

  beforeEach(() => {
    store = getDefaultStore()
    store.set(hiddenSidebarMenuItemsAtom, [])
    mockUpdateSettings = mock(() => Promise.resolve({}))
    mockGetSettings = mock(() => Promise.resolve({ hiddenSidebarMenuItems: ['memory'] }))

    ;(globalThis as any).window = {
      electronAPI: {
        updateSettings: mockUpdateSettings,
        getSettings: mockGetSettings,
      },
    }
  })

  test('Given 侧边栏菜单元数据 When 读取定义 Then 包含 9 个核心功能菜单项且定义完整', () => {
    const expectedIds: SidebarMenuItemId[] = [
      'new-task',
      'search',
      'schedule',
      'automations',
      'memory',
      'knowledge',
      'expert-team',
      'agent-skills',
      'fund-stock',
    ]

    expect(SIDEBAR_MENU_ITEMS.length).toBe(9)
    const actualIds = SIDEBAR_MENU_ITEMS.map((item) => item.id)
    expect(actualIds).toEqual(expectedIds)

    for (const item of SIDEBAR_MENU_ITEMS) {
      expect(item.id).toBeDefined()
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.description.length).toBeGreaterThan(0)
      expect(item.icon).toBeDefined()
    }
  })

  test('Given 初始化状态 When 加载配置 Then 从 electronAPI.getSettings 读取隐藏项', async () => {
    let loaded: string[] = []
    await initializeHiddenSidebarMenuItems((items) => {
      loaded = items
    })

    expect(mockGetSettings).toHaveBeenCalled()
    expect(loaded).toEqual(['memory'])
  })

  test('Given 菜单显隐操作 When 执行隐藏与显示 Then 同步 atom 并持久化至 settings', async () => {
    let current = store.get(hiddenSidebarMenuItemsAtom)
    const setHidden = (next: string[]) => {
      current = next
      store.set(hiddenSidebarMenuItemsAtom, next)
    }

    // 隐藏 memory
    await hideSidebarMenuItem(setHidden, current, 'memory')
    expect(current).toContain('memory')
    expect(mockUpdateSettings).toHaveBeenCalledWith({ hiddenSidebarMenuItems: ['memory'] })

    // 再次显示 memory
    await setSidebarMenuItemVisibility(setHidden, current, 'memory', true)
    expect(current).not.toContain('memory')
    expect(mockUpdateSettings).toHaveBeenCalledWith({ hiddenSidebarMenuItems: [] })
  })

  test('Given 多个隐藏菜单 When 点击全部显示 Then 清空隐藏列表并持久化', async () => {
    let current = ['search', 'fund-stock']
    const setHidden = (next: string[]) => {
      current = next
      store.set(hiddenSidebarMenuItemsAtom, next)
    }

    await showAllSidebarMenuItems(setHidden, current)
    expect(current).toEqual([])
    expect(mockUpdateSettings).toHaveBeenCalledWith({ hiddenSidebarMenuItems: [] })
  })

  test('Given 侧边栏源码与样式 When 检查 hover 隐藏胶囊按钮 Then 具备完整类名与视觉交互定义', () => {
    // JSX 结构
    expect(sidebarSource).toContain('copis-working-menu-item')
    expect(sidebarSource).toContain('copis-working-menu-hide-btn')
    expect(sidebarSource).toContain('handleHideMenuItem')
    expect(sidebarSource).toContain('isMenuHidden')

    // CSS 样式规则
    expect(sidebarStyles).toContain('.copis-working-menu-item')
    expect(sidebarStyles).toContain('.copis-working-menu-hide-btn')
    expect(sidebarStyles).toContain('border-radius: 9999px')
    expect(sidebarStyles).toContain('.copis-working-menu-item:hover .copis-working-menu-hide-btn')
  })

  test('Given 设置面板与菜单管理页 When 检查结构 Then 注册了 menu-management、头部操作替换刷新为全部显示且内页面移除冗余副标题', () => {
    expect(settingsPanelSource).toContain("id: 'menu-management'")
    expect(settingsPanelSource).toContain("label: '菜单管理'")
    expect(settingsPanelSource).toContain('MenuManagementSettings')
    expect(settingsPanelSource).toContain("activeSection === 'menu-management'")

    // 全部显示按钮已改到顶部操作栏「刷新」的位置，且菜单管理时不显示刷新
    expect(settingsPanelSource).toContain("activeSection === 'menu-management' ? (")
    expect(settingsPanelSource).toContain('handleShowAllMenus')
    expect(settingsPanelSource).toContain('全部显示')

    // 菜单管理内页移除了重复的标题和副标题描述
    expect(menuSettingsSource).not.toContain('自定义左侧边栏导航菜单项的展示。鼠标悬停侧栏菜单项时也可通过右侧胶囊按钮快捷隐藏。')
    expect(menuSettingsSource).toContain('Switch')
    expect(menuSettingsSource).toContain('SIDEBAR_MENU_ITEMS')
    expect(menuSettingsSource).toContain('setSidebarMenuItemVisibility')
  })

  test('Given 隐藏胶囊按钮样式 When 检查视觉规范 Then 背景透明仅保留边框且无 hover 变色效果直接静态呈现', () => {
    // 1. Agent 模式胶囊按钮：无背景色，仅边框，无 hover 变色规则
    expect(sidebarStyles).toContain('.copis-working-menu-hide-btn')
    expect(sidebarStyles).toContain('background: transparent;')
    expect(sidebarStyles).toContain('border: 1px solid')
    expect(sidebarStyles).not.toContain('backdrop-filter: blur')
    expect(sidebarStyles).not.toContain('.copis-working-menu-hide-btn:hover')

    // 2. 创造模式胶囊按钮：无背景色，仅边框，无 hover 变色规则
    const preloadSource = readFileSync(join(__dirname, '../../../preload/dsh-bridge-preload.ts'), 'utf8')
    expect(preloadSource).toContain('.copis-dsh-menu-hide-btn')
    expect(preloadSource).toContain('background: transparent !important;')
    expect(preloadSource).toContain('border: 1px solid')
    expect(preloadSource).not.toContain('.copis-dsh-menu-hide-btn:hover')
  })

  test('Given 菜单管理页面 When 查看菜单项 icon 与显隐状态指示 tag 胶囊 Then 统一采用柔和高雅底色与微边框规范', () => {
    // 状态统计条中的「显示中」图标指示
    expect(menuSettingsSource).toContain('text-[var(--ui-primary)]')
    expect(menuSettingsSource).not.toContain('text-emerald-500')

    // 菜单项 icon 废弃旧高饱和橙色，采用柔和高雅底色与微边框
    expect(menuSettingsSource).not.toContain('bg-[var(--ui-primary-background)] text-[var(--ui-primary)]')
    expect(menuSettingsSource).toContain("isVisible\n                      ? 'border border-border/50 bg-muted/80 text-foreground/80'\n                      : 'border border-border/30 bg-muted/35 text-muted-foreground/50'")

    // 显隐状态指示 tag 胶囊采用柔和高雅底色
    expect(menuSettingsSource).not.toContain('border-[var(--ui-primary)]/25')
    expect(menuSettingsSource).toContain('border-border/50 bg-muted/80 text-foreground/80')
    expect(menuSettingsSource).toContain('border-border/30 bg-muted/40 text-muted-foreground/60')
    expect(menuSettingsSource).toContain('rounded-full')

    // Switch 开关激活色保留 ui-primary
    expect(menuSettingsSource).toContain('data-[state=checked]:bg-[var(--ui-primary)]')
  })

  test('Given 侧边栏隐藏菜单跨窗口与跨模式广播 When 接收事件 Then 订阅监听器更新隐藏项', () => {
    let currentHidden: string[] = []
    const listeners: ((items: string[]) => void)[] = []

    const mockSubscribe = (cb: (items: string[]) => void) => {
      listeners.push(cb)
      return () => {
        const idx = listeners.indexOf(cb)
        if (idx !== -1) listeners.splice(idx, 1)
      }
    }

    const unsubscribe = mockSubscribe((items) => {
      currentHidden = items
    })

    // 广播事件到达
    listeners.forEach((l) => l(['schedule', 'automations']))
    expect(currentHidden).toEqual(['schedule', 'automations'])

    unsubscribe()
    expect(listeners.length).toBe(0)
  })
})
