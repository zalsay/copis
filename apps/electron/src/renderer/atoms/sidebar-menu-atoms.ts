/**
 * 侧边栏菜单项配置与显隐状态管理
 *
 * 管理左侧边栏菜单栏各功能项（新任务、搜索、日程表、定时任务、记忆、知识库、专家团队、技能市场、我的投资）
 * 的显示与隐藏状态，持久化到 ~/.copis/settings.json。
 */

import { atom } from 'jotai'
import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  Brain,
  CalendarClock,
  Plus,
  Puzzle,
  Search,
  Timer,
  TrendingUp,
  UsersRound,
} from 'lucide-react'

export type SidebarMenuItemId =
  | 'new-task'
  | 'search'
  | 'schedule'
  | 'automations'
  | 'memory'
  | 'knowledge'
  | 'expert-team'
  | 'agent-skills'
  | 'fund-stock'

export interface SidebarMenuItemDefinition {
  id: SidebarMenuItemId
  label: string
  description: string
  icon: LucideIcon
  targetView?: string
}

export const SIDEBAR_MENU_ITEMS: readonly SidebarMenuItemDefinition[] = [
  {
    id: 'new-task',
    label: '新任务',
    description: '快速发起全新 Agent 会话与工作任务',
    icon: Plus,
  },
  {
    id: 'search',
    label: '搜索',
    description: '全局搜索会话记录、知识文档与项目文件',
    icon: Search,
  },
  {
    id: 'schedule',
    label: '日程表',
    description: '查看和管理任务日程排期与规划',
    icon: CalendarClock,
    targetView: 'planning',
  },
  {
    id: 'automations',
    label: '定时任务',
    description: '配置自动化定时执行与周期性工作任务',
    icon: Timer,
    targetView: 'automations',
  },
  {
    id: 'memory',
    label: '记忆',
    description: '查看和维护 Copis Memory 长期上下文记忆',
    icon: Brain,
    targetView: 'memory',
  },
  {
    id: 'knowledge',
    label: '知识库',
    description: '管理独立知识库资料与检索摄取来源',
    icon: BookOpen,
    targetView: 'knowledge',
  },
  {
    id: 'expert-team',
    label: '专家团队',
    description: '组建并协同多 Agent 专家团队工作台',
    icon: UsersRound,
    targetView: 'expert-team',
  },
  {
    id: 'agent-skills',
    label: '技能市场',
    description: '浏览、安装与配置 Agent Skills 与 MCP 扩展',
    icon: Puzzle,
    targetView: 'agent-skills',
  },
  {
    id: 'fund-stock',
    label: '我的投资',
    description: '追踪股票与基金持仓分析及市场行情',
    icon: TrendingUp,
    targetView: 'fund-stock',
  },
] as const

/** 隐藏的侧边栏菜单项 ID 列表 */
export const hiddenSidebarMenuItemsAtom = atom<string[]>([])

/**
 * 从主进程加载隐藏菜单项设置
 */
export async function initializeHiddenSidebarMenuItems(
  setHidden: (items: string[]) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    const items = settings.hiddenSidebarMenuItems
    setHidden(Array.isArray(items) ? items : [])
  } catch (error) {
    console.error('[菜单管理] 初始化失败:', error)
  }
}

/**
 * 设置指定菜单项显隐状态并持久化
 */
export async function setSidebarMenuItemVisibility(
  setHidden: (items: string[]) => void,
  currentHidden: string[],
  itemId: string,
  visible: boolean,
): Promise<void> {
  const nextHidden = visible
    ? currentHidden.filter((id) => id !== itemId)
    : currentHidden.includes(itemId)
      ? currentHidden
      : [...currentHidden, itemId]
  setHidden(nextHidden)
  try {
    await window.electronAPI.updateSettings({ hiddenSidebarMenuItems: nextHidden })
  } catch (error) {
    setHidden(currentHidden)
    throw error
  }
}

/**
 * 快捷隐藏指定菜单项并持久化
 */
export async function hideSidebarMenuItem(
  setHidden: (items: string[]) => void,
  currentHidden: string[],
  itemId: string,
): Promise<void> {
  return setSidebarMenuItemVisibility(setHidden, currentHidden, itemId, false)
}

/**
 * 恢复所有菜单项显示
 */
export async function showAllSidebarMenuItems(
  setHidden: (items: string[]) => void,
  currentHidden: string[],
): Promise<void> {
  setHidden([])
  try {
    await window.electronAPI.updateSettings({ hiddenSidebarMenuItems: [] })
  } catch (error) {
    setHidden(currentHidden)
    throw error
  }
}
