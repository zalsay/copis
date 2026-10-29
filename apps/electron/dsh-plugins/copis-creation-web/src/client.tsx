import {
  BookOpen,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  Image as ImageIcon,
  PanelRight,
  PanelRightClose,
  Puzzle,
  RefreshCw,
  Search,
  Timer,
  TrendingUp,
  UsersRound,
  X,
  Bot,
  Loader2,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react'
import { CopisInspectorPanel } from './inspector/CopisInspectorPanel'

interface LayoutController {
  openDetails(): void
  closeDetails(): void
  toggleDetails?(): void
  toggleSidebar(): void
}

interface SessionState {
  id?: string
  sessionId?: string
  cwd?: string
  title?: string
  blank?: boolean
}

interface WorkspaceViewState {
  workspaceId: string
  path: string
  title: string
  sessionIds?: string[]
}

interface WorkspacesService {
  getSnapshot(): {
    items: WorkspaceViewState[]
  }
  subscribe(listener: () => void): () => void
}

interface SessionsService {
  list: {
    getSnapshot(): {
      current?: string
      items?: SessionState[]
      byId?: Record<string, SessionState>
    }
    subscribe(listener: () => void): () => void
  }
}

interface CordisContext {
  slots: {
    inject(name: string, callback: () => unknown): void
    register(
      metadata: {
        name: string
        id?: string
        order?: number
        children?: Record<string, unknown>
      },
      component: (props: any) => ReactElement | null,
    ): unknown
  }
  layout?: LayoutController
  sessions?: SessionsService
  workspaces?: WorkspacesService
}

type CreationView =
  | 'conversations'
  | 'planning'
  | 'automations'
  | 'memory'
  | 'knowledge'
  | 'expert-team'
  | 'agent-skills'
  | 'fund-stock'
  | 'group-chat'
  | 'settings'

interface SidebarMenuItem {
  id: string
  label: string
  icon: LucideIcon
  view?: Exclude<CreationView, 'conversations' | 'settings'>
  tab?: string
  action?: 'search'
  badge?: string
}

export interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export interface ReadFileResult {
  success: boolean
  content?: string
  isImage?: boolean
  error?: string
}

declare global {
  interface Window {
    copisBridge?: {
      navigate?: (view: string, tab?: string) => void
      openSearch?: () => void
      openSettings?: () => void
      hideMenuItem?: (menuId: string) => void
      getHiddenMenuItems?: () => string[]
      switchMode?: (mode: string) => void
      listDirectory?: (dirPath?: string, cwd?: string) => Promise<DirectoryEntry[]>
      getActiveWorkspacePath?: (cwd?: string) => Promise<string>
      readFile?: (filePath: string, cwd?: string) => Promise<ReadFileResult>
      showItemInFolder?: (filePath: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
      getAgentSessions?: () => Promise<any[]>
      searchAgentSessionMessages?: (query: string) => Promise<any[]>
      openSession?: (sessionType: 'agent' | 'chat', sessionId: string, title?: string) => void
    }
  }
}

const CREATION_STYLES_ID = 'copis-creation-web-styles'

const SIDEBAR_MENU_ITEMS: SidebarMenuItem[] = [
  { id: 'search', label: '搜索', icon: Search, action: 'search' },
  { id: 'schedule', label: '日程表', icon: CalendarClock, view: 'planning', tab: 'schedule' },
  { id: 'automations', label: '定时任务', icon: Timer, view: 'automations' },
  { id: 'memory', label: '记忆', icon: Brain, view: 'memory' },
  { id: 'knowledge', label: '知识库', icon: BookOpen, view: 'knowledge' },
  { id: 'expert-team', label: '专家团队', icon: UsersRound, view: 'expert-team' },
  { id: 'group-chat', label: '群聊协作', icon: UsersRound, view: 'group-chat' },
  { id: 'agent-skills', label: '技能市场', icon: Puzzle, view: 'agent-skills' },
  { id: 'fund-stock', label: '我的投资', icon: TrendingUp, view: 'fund-stock' },
]

const CREATION_UI_CSS = `
  [class*="_logoRow"],
  [class*="logoRow"],
  [class*="_localBuildBrand"],
  [class*="localBuildBrand"] {
    display: none !important;
  }

  /* 侧边栏容器背景：对齐 Agent 模式 (hsl(var(--muted))) */
  .copis-creation-sidebar,
  .hHd-Xa_root,
  [class*="SidebarRoot_root"],
  [class*="SidebarRoot"],
  [class*="_sidebarCol"],
  [class*="sidebarCol"],
  aside.copis-creation-sidebar {
    background: var(--dsw-specific-sidebar-fill, hsl(0 0% 96.1%)) !important;
  }
  body[data-ds-dark-theme] .copis-creation-sidebar,
  body[data-ds-dark-theme] .hHd-Xa_root,
  body[data-ds-dark-theme] [class*="SidebarRoot_root"],
  body[data-ds-dark-theme] [class*="SidebarRoot"],
  body[data-ds-dark-theme] [class*="_sidebarCol"],
  body[data-ds-dark-theme] [class*="sidebarCol"],
  body[data-ds-dark-theme] aside.copis-creation-sidebar {
    background: var(--dsw-specific-sidebar-fill, hsl(0 0% 17%)) !important;
  }

  /* 隐藏 DSH 原生侧栏中遗留的旧版静态菜单（无 data-copis-placement），只保留 copis-creation-web 插件动态挂载的导航菜单 */
  .copis-menu-section:not([data-copis-placement="before-workspaces"]),
  .copis-rail-menu-section:not([data-copis-placement="before-workspaces"]) {
    display: none !important;
  }

  .copis-menu-section {
    box-sizing: border-box;
    display: grid;
    flex: none;
    gap: 0;
    width: 100%;
    margin: 0 0 8px;
    padding: 0 2px;
  }

  .copis-menu-item {
    appearance: none;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 31px;
    padding: 5px 8px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
    font-size: 14px;
    font-weight: 400;
    line-height: 1.25;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
    user-select: none;
  }

  .copis-menu-item:hover,
  .copis-menu-item:focus-visible {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
    outline: 0;
  }

  .copis-menu-item[data-active="true"] {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
    font-weight: 500 !important;
  }

  .copis-menu-item svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: var(--dsw-alias-label-secondary, #90939e);
  }

  .copis-menu-item[data-active="true"] svg {
    color: #ffffff !important;
  }

  .copis-menu-item > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .copis-menu-item > .copis-dsh-menu-hide-btn {
    position: static !important;
    margin-left: auto;
    flex: none;
    display: none;
    padding: 1px 6px;
    font-size: 11px;
    line-height: 16px;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.08);
    color: var(--dsw-alias-label-secondary, #71717a);
    border: none;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-menu-item:hover > .copis-dsh-menu-hide-btn {
    display: inline-flex;
    align-items: center;
  }

  .copis-menu-item > .copis-dsh-menu-hide-btn:hover {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .copis-rail-menu-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 100%;
    margin-bottom: 8px;
  }

  .copis-rail-menu-item {
    appearance: none;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: var(--dsw-alias-label-secondary, #71717a);
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-rail-menu-item:hover,
  .copis-rail-menu-item:focus-visible {
    background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
    color: var(--dsw-alias-label-primary, #18181b);
    outline: 0;
  }

  .copis-rail-menu-item[data-active="true"] {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
  }

  .copis-rail-menu-item svg {
    width: 16px;
    height: 16px;
  }

  button[class*="_newSession"],
  button[class*="newSession"] {
    border-radius: 7px !important;
    font-size: 14px !important;
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    color: #f1f5f9 !important;
    transition: all 120ms ease !important;
  }
  button[class*="_newSession"]:hover,
  button[class*="newSession"]:hover {
    background: rgba(255, 255, 255, 0.09) !important;
    border-color: rgba(255, 255, 255, 0.14) !important;
  }

  [class*="sessionRow"],
  [class*="SessionRow"] {
    border-radius: 7px !important;
    font-size: 14px !important;
    transition: all 120ms ease !important;
  }
  [class*="sessionRow"]:hover,
  [class*="SessionRow"]:hover {
    background: rgba(255, 255, 255, 0.04) !important;
  }
  /* WorkBuddy 浅灰/曜石微高光卡片会话行选中态，彻底去除紫色 */
  .YDXeBa_sessionRow.YDXeBa_selected,
  .YDXeBa_searchResultRow.YDXeBa_selected,
  .YDXeBa_projectRow.active,
  [class*="sessionRow"][class*="selected"],
  [class*="searchResultRow"][class*="selected"],
  [class*="projectRow"][class*="active"],
  [class*="sessionRow"][data-selected="true"],
  [class*="SessionRow"][data-selected="true"] {
    background: rgba(255, 255, 255, 0.1) !important;
    color: #ffffff !important;
    font-weight: 500 !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected *,
  [class*="sessionRow"][class*="selected"] * {
    color: #ffffff !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected [class*="date"],
  .YDXeBa_sessionRow.YDXeBa_selected [class*="time"],
  [class*="sessionRow"][class*="selected"] [class*="date"],
  [class*="sessionRow"][class*="selected"] [class*="time"],
  [class*="sessionRow"][class*="selected"] span:last-child {
    color: #a1a1aa !important;
  }
  [class*="sessionRow"][class*="selected"] svg,
  [class*="searchResultRow"][class*="selected"] svg,
  [class*="projectRow"][class*="active"] svg {
    color: #d4d4d8 !important;
  }
  /* 侧栏工作区目录/项目图标：全部对齐 WorkBuddy 浅银灰色，绝不显示亮紫色 */
  .YDXeBa_projectRow svg,
  [class*="projectRow"] svg,
  [class*="workspaceRow"] svg {
    color: #a1a1aa !important;
  }

  /* WorkBuddy 风格顶部 Tab 导航（对话 / 轨迹）：纯净白色文字与白色指示条 */
  .wSkVaW_tab,
  [class*="wSkVaW_tab"],
  [class*="_tab"][role="tab"] {
    color: #94a3b8 !important;
    font-weight: 500 !important;
    transition: color 120ms ease !important;
  }
  .wSkVaW_tab:hover,
  [class*="wSkVaW_tab"]:hover,
  [class*="_tab"][role="tab"]:hover {
    color: #cbd5e1 !important;
  }
  .wSkVaW_tabActive,
  [class*="wSkVaW_tabActive"],
  [class*="_tabActive"],
  button[role="tab"][aria-selected="true"],
  [class*="tab"][class*="active"],
  [class*="tab"][data-active="true"] {
    color: #ffffff !important;
    font-weight: 600 !important;
  }
  .wSkVaW_tabActive:after,
  [class*="wSkVaW_tabActive"]:after,
  [class*="_tabActive"]:after,
  button[role="tab"][aria-selected="true"]:after,
  [class*="tab"][class*="active"]:after,
  [class*="tab"][data-active="true"]:after {
    background: #ffffff !important;
    height: 2px !important;
    border-radius: 1px !important;
  }

  /* WorkBuddy 菜单徽标样式：全灰阶轻量微胶囊 */
  .copis-menu-badge {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.02em;
    background: rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    border: 1px solid rgba(255, 255, 255, 0.08);
    flex: none;
    line-height: 14px;
  }
  .copis-menu-badge-beta {
    background: rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    border-color: rgba(255, 255, 255, 0.08);
  }
  .copis-menu-badge-flexible {
    background: rgba(255, 255, 255, 0.06);
    color: #a1a1aa;
    border-color: rgba(255, 255, 255, 0.06);
  }

  /* 优雅紫色半透明毛玻璃 Composer 输入胶囊卡片（背景更深，紫色更淡内敛） */
  [class*="uV2eYG_card"],
  [class*="_card"][class*="composer"] {
    border-radius: 20px !important;
    background: color-mix(in srgb, var(--creation-ui-primary, #a855f7) 7%, rgba(16, 17, 24, 0.90)) !important;
    -webkit-backdrop-filter: blur(24px) !important;
    backdrop-filter: blur(24px) !important;
    border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #a855f7) 12%, rgba(255, 255, 255, 0.08)) !important;
    box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.6), 0 0 20px -4px color-mix(in srgb, var(--creation-ui-primary, #a855f7) 8%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
    margin-bottom: 16px !important;
    padding-top: 10px !important;
  }

  body:not([data-ds-dark-theme]) [class*="uV2eYG_card"],
  body:not([data-ds-dark-theme]) [class*="_card"][class*="composer"] {
    background: color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 4%, rgba(255, 255, 255, 0.88)) !important;
    border: 1px solid color-mix(in srgb, var(--creation-ui-primary, #6c00cc) 10%, rgba(0, 0, 0, 0.08)) !important;
    box-shadow: 0 16px 36px -8px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.8) !important;
  }

  [class*="uV2eYG_input"] {
    color: #f1f5f9 !important;
    font-size: 13.5px !important;
    line-height: 22px !important;
  }

  [class*="uV2eYG_placeholder"] {
    color: #64748b !important;
    font-size: 13.5px !important;
  }

  [class*="uV2eYG_add"] {
    background: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 9999px !important;
    color: #cbd5e1 !important;
  }

  [class*="uV2eYG_add"]:hover {
    background: rgba(255, 255, 255, 0.09) !important;
    color: #ffffff !important;
  }

  [class*="uV2eYG_select"] {
    background-color: rgba(255, 255, 255, 0.05) !important;
    border: 1px solid rgba(255, 255, 255, 0.08) !important;
    border-radius: 9999px !important;
    color: #e2e8f0 !important;
    font-size: 12px !important;
    padding: 0 20px 0 10px !important;
  }

  [class*="uV2eYG_select"]:hover {
    background-color: rgba(255, 255, 255, 0.09) !important;
  }

  /* WorkBuddy 浅曜石灰极简发送按钮，彻底消除红色与亮紫色 */
  [class*="uV2eYG_primary"],
  button[class*="uV2eYG_primary"],
  [class*="composer"] button[type="submit"] {
    border-radius: 9999px !important;
    background: #3f414a !important; /* fallback token: var(--ui-primary) */
    color: #f1f5f9 !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25) !important;
    transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease !important;
  }

  [class*="uV2eYG_primary"]:hover:not(:disabled),
  button[class*="uV2eYG_primary"]:hover:not(:disabled),
  [class*="composer"] button[type="submit"]:hover:not(:disabled) {
    background: #4d505a !important;
    border-color: rgba(255, 255, 255, 0.24) !important;
    color: #ffffff !important;
    transform: scale(1.05) !important;
  }

  [class*="uV2eYG_primary"]:disabled,
  button[class*="uV2eYG_primary"]:disabled,
  [class*="composer"] button[type="submit"]:disabled {
    background: rgba(255, 255, 255, 0.06) !important;
    color: rgba(255, 255, 255, 0.25) !important;
    border: 1px solid rgba(255, 255, 255, 0.05) !important;
    box-shadow: none !important;
    cursor: not-allowed !important;
    transform: none !important;
  }

  [class*="uV2eYG_root"]::after {
    content: "内容由 AI 生成，请核实重要信息";
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: rgba(148, 163, 184, 0.6);
    text-align: center;
    user-select: none;
  }

  /* 页面视口与对话容器：彻底消除横向多余滚动条与 hover 闪烁 */
  html,
  body,
  [class*="_centerCol"],
  [class*="centerCol"],
  [class*="_frame"],
  [class*="frame"],
  [data-view="conversation"],
  main,
  [class*="uV2eYG_root"] {
    overflow-x: clip !important;
    max-width: 100% !important;
  }

  /* 强制屏蔽页面与卡片底部的横向多余滚动条 */
  html::-webkit-scrollbar:horizontal,
  body::-webkit-scrollbar:horizontal,
  [class*="_centerCol"]::-webkit-scrollbar:horizontal,
  [class*="centerCol"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_root"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_card"]::-webkit-scrollbar:horizontal,
  [class*="uV2eYG_row"]::-webkit-scrollbar:horizontal {
    display: none !important;
    height: 0 !important;
    width: 0 !important;
  }

  /* 上下文用量圆环（ContextMeter）与底部工具按钮悬浮 Tooltip 定位边界防溢出保护 */
  [class*="JObwrW_root"] {
    overflow: visible !important;
  }

  [class*="JObwrW_root"] [role="tooltip"],
  [class*="JObwrW_root"] [class*="tooltip"],
  [class*="JObwrW_root"] [class*="Tooltip"] {
    right: 0 !important;
    left: auto !important;
    max-width: 240px !important;
    white-space: nowrap !important;
    pointer-events: none !important;
  }

  /* 全局 Tooltip 浮层尺寸保护：避免绝对定位或动画帧撑大视口底部 */
  [role="tooltip"],
  [class*="tooltip"],
  [class*="Tooltip"] {
    max-width: calc(100vw - 32px) !important;
    word-break: break-word !important;
    pointer-events: none !important;
  }

  /* 当 Copis 子视图（规划/记忆/知识库/专家团队等）激活时：
     1. 彻底隐藏 DSH 原生中间对话区、欢迎屏、输入区与右侧详情栏；
     2. 强制 DSH 外层 Frame 与侧边栏独占整个 WebContentsView 视口 (100%)；
     3. 强制 DSH 侧边栏保持展开宽态 (Wide)，严禁误折叠为窄 Rail。 */
  body.copis-subview-active [class*="_centerCol"],
  body.copis-subview-active [class*="centerCol"],
  body.copis-subview-active [class*="_detailsCol"],
  body.copis-subview-active [class*="detailsCol"],
  body.copis-subview-active [class*="_handle"],
  body.copis-subview-active [class*="handle"],
  body.copis-subview-active [data-view="conversation"],
  body.copis-subview-active main {
    display: none !important;
    width: 0 !important;
    min-width: 0 !important;
    max-width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }

  body.copis-subview-active [class*="_frame"],
  body.copis-subview-active [class*="frame"] {
    display: flex !important;
    grid-template-columns: 100% !important;
    width: 100% !important;
    height: 100% !important;
  }

  body.copis-subview-active [class*="_sidebarCol"],
  body.copis-subview-active [class*="sidebarCol"] {
    display: flex !important;
    flex: 1 1 100% !important;
    width: 100% !important;
    max-width: 100% !important;
    height: 100% !important;
    border-right: none !important;
  }

  body.copis-subview-active aside.copis-creation-sidebar,
  body.copis-subview-active aside.hHd-Xa_root,
  body.copis-subview-active aside[class*="SidebarRoot"],
  body.copis-subview-active aside {
    width: 100% !important;
    padding: 6px var(--dsh-sidebar-inline-padding, 12px) !important;
  }

  /* 当子视图激活时，原「新会话」按钮无缝切换为「返回会话」按钮（WorkBuddy 浅灰质感） */
  body.copis-subview-active button[class*="_newSession"],
  body.copis-subview-active button[class*="newSession"] {
    display: flex !important;
    align-items: center !important;
    width: 100% !important;
    height: 36px !important;
    margin: 0 0 12px !important;
    padding: 0 12px !important;
    gap: 8px !important;
    background: rgba(255, 255, 255, 0.08) !important; /* fallback token: var(--creation-ui-primary-background) */
    color: #ffffff !important;
    border: 1px solid rgba(255, 255, 255, 0.14) !important;
    border-radius: 7px !important;
    align-self: stretch !important;
    cursor: pointer !important;
    transition: background-color 150ms ease, border-color 150ms ease !important;
    box-sizing: border-box !important;
  }

  body.copis-subview-active button[class*="_newSession"]:hover,
  body.copis-subview-active button[class*="newSession"]:hover {
    background: rgba(255, 255, 255, 0.12) !important;
    border-color: rgba(255, 255, 255, 0.22) !important;
  }

  /* 隐藏原「新建会话」图标 */
  body.copis-subview-active button[class*="_newSession"] svg,
  body.copis-subview-active button[class*="newSession"] svg {
    display: none !important;
  }

  /* 注入返回会话矢量箭头图标（仅作用于外层 button 前缀） */
  body.copis-subview-active button[class*="_newSession"]::before,
  body.copis-subview-active button[class*="newSession"]::before {
    content: "" !important;
    display: inline-block !important;
    width: 15px !important;
    height: 15px !important;
    flex: none !important;
    background-color: currentColor !important;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m12 19-7-7 7-7'/%3E%3Cpath d='M19 12H5'/%3E%3C/svg%3E") no-repeat center / contain !important;
  }

  /* 隐藏原「新会话」文字，替换为「返回会话」，确保内部 label 绝不带多余边框、背景或伪类箭头 */
  body.copis-subview-active [class*="newSessionLabel"],
  body.copis-subview-active [class*="_newSessionLabel"] {
    font-size: 0 !important;
    max-width: none !important;
    opacity: 1 !important;
    display: inline-flex !important;
    align-items: center !important;
    flex: 1 1 auto !important;
    min-width: 0 !important;
    overflow: hidden !important;
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
    height: auto !important;
    color: currentColor !important;
    box-shadow: none !important;
  }

  body.copis-subview-active [class*="newSessionLabel"]::before,
  body.copis-subview-active [class*="_newSessionLabel"]::before {
    content: none !important;
    display: none !important;
  }

  body.copis-subview-active [class*="newSessionLabel"]::after,
  body.copis-subview-active [class*="_newSessionLabel"]::after {
    content: "返回会话" !important;
    font-size: 14px !important;
    font-weight: 600 !important;
    line-height: 20px !important;
    color: currentColor !important;
    white-space: nowrap !important;
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    margin: 0 !important;
  }

  /* 在按钮最右侧展示精致的 Esc 快捷键胶囊（仅作用于外层 button 自身） */
  body.copis-subview-active button[class*="_newSession"]::after,
  body.copis-subview-active button[class*="newSession"]::after {
    content: "Esc" !important;
    margin-left: auto !important;
    font-size: 10px !important;
    font-weight: 500 !important;
    font-family: ui-monospace, monospace !important;
    line-height: 1 !important;
    padding: 2px 5px !important;
    border-radius: 4px !important;
    border: 1px solid currentColor !important;
    opacity: 0.7 !important;
    background: transparent !important;
    color: currentColor !important;
    flex: none !important;
  }

  /* 当子视图激活时，彻底隐藏浮动工具栏（工作区、Agent模式），避免挤占/遮挡侧栏顶部 */
  body.copis-subview-active .copis-hero-utilities-overlay {
    display: none !important;
  }

  body.copis-subview-active [class*="_regionArea"],
  body.copis-subview-active [class*="regionArea"] {
    display: flex !important;
    flex-direction: column !important;
    margin-left: -4px !important;
    margin-right: calc(-1 * var(--dsh-sidebar-inline-padding, 12px)) !important;
    padding-left: 4px !important;
  }

  /* 确保侧边栏工作区顶栏未展开搜索时，搜索按钮与操作按钮完整呈现，防止被 flex 压缩或裁剪 */
  [class*="sectionHeader"] {
    display: flex !important;
    align-items: center !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) {
    display: flex !important;
    min-width: 28px !important;
    max-width: 28px !important;
    flex: 0 0 28px !important;
    margin-left: auto !important;
    opacity: 1 !important;
    visibility: visible !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="search"] {
    display: flex !important;
    width: 28px !important;
    height: 28px !important;
  }
  [class*="searchSlot"]:not([class*="searchSlotExpanded"]):not([class*="_searchSlotExpanded"]) [class*="searchButton"] {
    display: inline-flex !important;
    width: 28px !important;
    height: 28px !important;
  }
  [class*="headerActions"]:not([class*="headerActionsHidden"]):not([class*="_headerActionsHidden"]) {
    display: flex !important;
    align-items: center !important;
    gap: 4px !important;
    min-width: 60px !important;
    max-width: none !important;
    flex: 0 0 auto !important;
    opacity: 1 !important;
    visibility: visible !important;
  }

  body.copis-subview-active .copis-menu-section {
    display: grid !important;
  }

  body.copis-subview-active [class*="_footArea"],
  body.copis-subview-active [class*="footArea"] {
    align-items: stretch !important;
  }

  /* 中部对话区右上角工具栏 */
  .copis-header-utilities-bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .copis-hero-utilities-overlay {
    position: fixed;
    top: 14px;
    right: 18px;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: auto;
  }

  .copis-header-action-btn {
    appearance: none;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border-radius: 7px;
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.12));
    background: var(--dsw-alias-button-elevated-fill, rgba(120, 120, 128, 0.06));
    color: var(--dsw-alias-label-primary, inherit);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 120ms ease;
    user-select: none;
  }

  .copis-header-action-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.15));
    border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
  }

  .copis-header-action-btn:active {
    transform: scale(0.97);
  }

  /* 隐藏顶部右上角原生的 session-log-download 及任何 Agent 模式切换按钮 */
  button[class*="sessionLogButton"],
  button[title*="返回 Agent 模式"],
  button[title*="返回Agent 模式"],
  button[aria-label*="返回 Agent 模式"],
  button[aria-label*="返回Agent 模式"],
  .copis-header-btn-agent,
  [data-slot-id="session-log-download"] {
    display: none !important;
  }

  .copis-header-btn-agent {
    display: none !important;
    border: 1px solid color-mix(in srgb, var(--ui-primary, #f09a43) 30%, transparent) !important;
    background: var(--ui-primary-background, rgba(240, 161, 90, 0.15)) !important;
    color: var(--ui-primary, #f09a43) !important;
    border-radius: 7px !important;
    font-size: 13px !important;
    font-weight: 500 !important;
  }

  .copis-header-btn-agent:hover {
    background: color-mix(in srgb, var(--ui-primary, #f09a43) 22%, var(--ui-primary-background, rgba(240, 161, 90, 0.15))) !important;
    border-color: color-mix(in srgb, var(--ui-primary, #f09a43) 50%, transparent) !important;
  }

  .copis-header-btn-workspace {
    width: 30px !important;
    height: 30px !important;
    padding: 0 !important;
    border-radius: 7px !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08)) !important;
    background: var(--dsw-alias-button-elevated-fill, rgba(255, 255, 255, 0.04)) !important;
    color: var(--dsw-alias-label-secondary, #94a3b8) !important;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04) !important;
    backdrop-filter: blur(8px) !important;
    transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1) !important;
  }

  .copis-header-btn-workspace:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08)) !important;
    color: var(--dsw-alias-label-primary, #ffffff) !important;
    border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.16)) !important;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08) !important;
  }

  .copis-header-btn-workspace:active {
    transform: scale(0.95) !important;
  }

  .copis-header-btn-workspace[data-active="true"] {
    background: rgba(255, 255, 255, 0.14) !important;
    border: 1px solid rgba(255, 255, 255, 0.22) !important;
    color: #ffffff !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
  }

  .copis-header-btn-workspace[data-active="true"]:hover {
    background: rgba(255, 255, 255, 0.18) !important;
    border-color: rgba(255, 255, 255, 0.28) !important;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
  }

  /* 中部聊天区：支持与侧边抽屉并列推入的平滑宽度过渡（Push-in 挤压） */
  :root {
    --copis-inspector-width: 500px;
  }

  [class*="_centerCol"],
  [class*="centerCol"] {
    transition: margin-right 220ms cubic-bezier(0.16, 1, 0.3, 1) !important;
  }

  body.copis-details-drawer-open [class*="_centerCol"],
  body.copis-details-drawer-open [class*="centerCol"] {
    margin-right: var(--copis-inspector-width, 500px) !important;
  }

  /* 欢迎屏常驻右上角操作栏：跟随推入平滑左移，防止与抽屉重叠 */
  .copis-hero-utilities-overlay {
    transition: right 220ms cubic-bezier(0.16, 1, 0.3, 1) !important;
  }

  body.copis-details-drawer-open .copis-hero-utilities-overlay {
    right: calc(var(--copis-inspector-width, 500px) + 18px) !important;
  }

  /* 右侧工作区全功能 Inspector 抽屉样式（纯正灰色 WorkBuddy 浅灰/暗黑风格，推入式滑入抽屉，无遮罩，无紫色） */
  .copis-details-drawer-root {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: var(--copis-inspector-width, 500px);
    max-width: calc(100vw - 320px);
    z-index: 85;
    background: #18181b;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border-left: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.35);
    display: flex;
    flex-direction: column;
    color: #f4f4f5;
    transform: translateX(100%);
    visibility: hidden;
    pointer-events: none;
    transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), visibility 220ms ease;
  }

  body:not([data-ds-dark-theme]) .copis-details-drawer-root {
    background: #f4f4f5;
    color: #18181b;
    border-left: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.08);
  }

  body.copis-details-drawer-open .copis-details-drawer-root {
    transform: translateX(0);
    visibility: visible;
    pointer-events: auto;
  }

  /* 拖拽调整抽屉宽度时的即时响应保护（禁用 transition 避免滞后延迟） */
  body.copis-inspector-resizing [class*="_centerCol"],
  body.copis-inspector-resizing [class*="centerCol"],
  body.copis-inspector-resizing .copis-details-drawer-root,
  body.copis-inspector-resizing .copis-hero-utilities-overlay {
    transition: none !important;
  }

  /* 抽屉左侧可拖拽调整尺寸边框 */
  .copis-inspector-resize-handle {
    position: absolute;
    top: 0;
    left: -3px;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 100;
    touch-action: none;
    background: transparent;
    transition: background-color 150ms ease;
  }

  .copis-inspector-resize-handle:hover,
  .copis-inspector-resize-handle[data-resizing="true"] {
    background: rgba(255, 255, 255, 0.22);
  }

  body:not([data-ds-dark-theme]) .copis-inspector-resize-handle:hover,
  body:not([data-ds-dark-theme]) .copis-inspector-resize-handle[data-resizing="true"] {
    background: rgba(0, 0, 0, 0.2);
  }

  /* 子视图激活时强制隐藏抽屉，保证全屏子视图整洁 */
  body.copis-subview-active .copis-details-drawer-root {
    display: none !important;
  }

  /* 搜索浮层全局遮罩与弹窗：保持底层 DSH 视图完全可见，绝不触发全黑全白 */
  .copis-search-modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1000;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
    animation: copis-search-modal-fade-in 140ms ease-out;
  }

  @keyframes copis-search-modal-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .copis-search-modal-card {
    width: 580px;
    max-width: calc(100vw - 32px);
    max-height: 520px;
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-primary, #18181b);
    border: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.1));
    border-radius: 12px;
    box-shadow: 0 20px 48px -12px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.05);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-family: var(--dsw-font-family, system-ui, sans-serif);
    animation: copis-search-modal-scale-in 140ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes copis-search-modal-scale-in {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .copis-search-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
  }

  .copis-search-main-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-size: 14px;
    color: var(--dsw-alias-label-primary, inherit);
    line-height: 20px;
  }

  .copis-search-main-input::placeholder {
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
  }

  .copis-search-submit-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.1);
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-search-submit-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.22);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .copis-search-submit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .copis-search-results-list {
    max-height: 380px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .copis-search-item-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    cursor: pointer;
    border: none;
    background: transparent;
    width: 100%;
    text-align: left;
    color: inherit;
    font-family: inherit;
    transition: background-color 100ms ease;
  }

  .copis-search-item-row:hover,
  .copis-search-item-row[data-selected="true"] {
    background: rgba(255, 255, 255, 0.08) !important;
  }

  .copis-search-badge-creation {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: #e4e4e7;
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-weight: 500;
    flex-shrink: 0;
  }

  .copis-search-badge-agent {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: rgba(240, 154, 67, 0.15);
    color: #f09a43;
    font-weight: 500;
    flex-shrink: 0;
  }

  .copis-search-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    font-size: 11px;
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
    background: var(--dsw-alias-bg-base, inherit);
    flex-shrink: 0;
  }

  /* ========================================================
     Copis 创造模式 Inspector 多页签系统样式 (参考 cc-sandbox)
     ======================================================== */
  .copis-inspector-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    font-family: var(--dsw-font-family, system-ui, sans-serif);
    color: #f4f4f5;
  }

  .copis-inspector-tabbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 38px;
    padding: 0 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.22);
    flex-shrink: 0;
    gap: 8px;
  }

  .copis-inspector-tab-list {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    flex: 1;
    min-width: 0;
    padding: 2px 0;
    scrollbar-width: none;
  }

  .copis-inspector-tab-list::-webkit-scrollbar {
    display: none;
  }

  /* WorkBuddy 风格浅灰微光 Tab 项 */
  .copis-inspector-tab-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    background: transparent;
    color: #a1a1aa;
    transition: all 120ms ease;
    user-select: none;
    white-space: nowrap;
  }

  .copis-inspector-tab-item:hover {
    background: rgba(255, 255, 255, 0.06);
    color: #e4e4e7;
  }

  .copis-inspector-tab-item[data-active="true"] {
    background: rgba(255, 255, 255, 0.14) !important;
    color: #ffffff !important;
    border-color: rgba(255, 255, 255, 0.18) !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.12) !important;
  }

  /* 侧栏上方 Tab 激活时，Icon 统一使用紫色高亮 */
  .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon,
  .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon svg {
    color: #a855f7 !important;
    stroke: #a855f7 !important;
  }

  body:not([data-ds-dark-theme]) .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon,
  body:not([data-ds-dark-theme]) .copis-inspector-tab-item[data-active="true"] .copis-inspector-tab-icon svg {
    color: #9333ea !important;
    stroke: #9333ea !important;
  }

  .copis-inspector-tab-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .copis-inspector-tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 140px;
  }

  .copis-inspector-tab-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    margin-left: 2px;
    color: #71717a;
    transition: all 100ms ease;
  }

  .copis-inspector-tab-close:hover {
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
  }

  .copis-inspector-tabbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .copis-inspector-tool-icon-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    color: #a1a1aa;
    border-radius: 6px;
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 120ms ease;
  }

  .copis-inspector-tool-icon-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }

  .copis-inspector-add-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .copis-inspector-add-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    min-width: 150px;
    background: rgba(24, 24, 32, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    padding: 4px;
    z-index: 200;
    display: flex;
    flex-direction: column;
    gap: 2px;
    backdrop-filter: blur(16px);
  }

  .copis-inspector-dropdown-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    color: #d4d4d8;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
    transition: all 100ms ease;
  }

  .copis-inspector-dropdown-item:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
  }

  .copis-inspector-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ------------------- 文件面板 (Files Tab) ------------------- */
  .copis-inspector-files-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .copis-inspector-files-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.12);
    flex-shrink: 0;
    font-size: 11px;
    gap: 8px;
  }

  .copis-inspector-files-breadcrumb {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #a1a1aa;
    flex: 1;
    min-width: 0;
  }

  .copis-inspector-files-topbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .copis-inspector-files-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .copis-inspector-files-tree-col {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: rgba(0, 0, 0, 0.08);
  }

  .copis-inspector-files-preview-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.04);
  }

  .copis-inspector-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 32px 16px;
    text-align: center;
  }

  .copis-inspector-code-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }

  .copis-inspector-code-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    font-size: 11px;
    color: #a1a1aa;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.15);
    flex-shrink: 0;
  }

  /* ------------------- 侧边聊天面板 (Side Chat Tab) ------------------- */
  .copis-inspector-sidechat-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .copis-inspector-sidechat-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.12);
    flex-shrink: 0;
  }

  .copis-inspector-sidechat-messages {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .copis-sidechat-message-row {
    display: flex;
    gap: 8px;
    max-width: 90%;
  }

  .copis-sidechat-message--user {
    align-self: flex-end;
    flex-direction: row-reverse;
  }

  .copis-sidechat-message--assistant {
    align-self: flex-start;
  }

  .copis-sidechat-avatar {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: #a1a1aa;
  }

  .copis-sidechat-bubble {
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    line-height: 1.5;
    color: #f4f4f5;
  }

  .copis-sidechat-message--user .copis-sidechat-bubble {
    background: rgba(255, 255, 255, 0.12);
    border: 1px solid rgba(255, 255, 255, 0.15);
  }

  .copis-sidechat-message--assistant .copis-sidechat-bubble {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .copis-sidechat-time {
    font-size: 10px;
    color: #71717a;
    margin-top: 4px;
    text-align: right;
  }

  .copis-sidechat-thinking {
    color: #a1a1aa;
    font-style: italic;
  }

  .copis-sidechat-preset-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 8px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.1);
  }

  .copis-sidechat-chip-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-sidechat-chip-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.22);
    color: #ffffff;
  }

  .copis-inspector-sidechat-input-box {
    padding: 10px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }

  .copis-sidechat-textarea {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 12px;
    color: #f4f4f5;
    resize: none;
    outline: none;
    font-family: inherit;
  }

  .copis-sidechat-textarea:focus {
    border-color: rgba(255, 255, 255, 0.24);
  }

  .copis-sidechat-input-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .copis-sidechat-send-btn {
    background: #3f414a;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 5px;
    color: #ffffff;
    padding: 4px 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 120ms ease;
  }

  .copis-sidechat-send-btn:hover:not(:disabled) {
    background: #4d505a;
    border-color: rgba(255, 255, 255, 0.24);
  }

  .copis-sidechat-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ------------------- 团队面板 (Team Tab) ------------------- */
  .copis-inspector-team-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .copis-inspector-team-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 32px;
    padding: 0 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.12);
    flex-shrink: 0;
  }

  .copis-team-stats-badge {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: #a1a1aa;
  }

  .copis-team-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    font-weight: 600;
    color: #d4d4d8;
    margin-bottom: 8px;
  }

  .copis-team-member-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    cursor: pointer;
    transition: all 120ms ease;
  }

  .copis-team-member-item:hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.14);
  }

  .copis-team-avatar-mini {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .copis-team-role-tag {
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
    color: #e4e4e7;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  .copis-team-status-chip {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 7px;
    border-radius: 10px;
    flex-shrink: 0;
  }

  .copis-team-status--running {
    background: rgba(255, 255, 255, 0.12);
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.2);
  }

  .copis-team-status--ready {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .copis-team-status--idle {
    background: rgba(255, 255, 255, 0.06);
    color: #a1a1aa;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .copis-team-task-item {
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    overflow: hidden;
  }

  .copis-team-task-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    cursor: pointer;
    transition: background 100ms ease;
  }

  .copis-team-task-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .copis-team-task-details {
    padding: 8px 10px 10px 28px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 11px;
    color: #a1a1aa;
    background: rgba(0, 0, 0, 0.1);
  }

  .copis-team-task-meta-grid {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }

  .copis-team-meta-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .copis-team-meta-key {
    color: #71717a;
    min-width: 54px;
  }

  .copis-team-meta-val {
    color: #e4e4e7;
    font-weight: 500;
  }

  .copis-team-back-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 5px;
    font-size: 11px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #f4f4f5;
    cursor: pointer;
  }

  .copis-team-member-card {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 14px;
  }

  .copis-team-avatar-box {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .copis-team-skill-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: #d4d4d8;
  }

  .copis-team-subagent-log-box {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: rgba(0, 0, 0, 0.2);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 10px;
  }

  .copis-team-subagent-log-item {
    display: flex;
    gap: 8px;
    font-size: 11px;
    font-family: monospace;
  }

  .copis-team-log-time {
    color: #71717a;
  }

  .copis-team-log-text {
    color: #d4d4d8;
  }

  /* 兼容旧版单一面板类 */
  .copis-details-panel-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--dsw-alias-bg-base, inherit);
    color: var(--dsw-alias-label-primary, inherit);
    font-family: var(--dsw-font-family, system-ui, sans-serif);
  }

  .copis-details-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px 8px;
    border-bottom: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    gap: 8px;
  }

  .copis-details-tabs-group {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08));
    padding: 2px;
    border-radius: 8px;
  }

  .copis-details-tab-button {
    appearance: none;
    border: none;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    background: transparent;
    color: var(--dsw-alias-label-secondary, #71717a);
    transition: all 120ms ease;
  }

  .copis-details-tab-button[data-active="true"] {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .copis-details-close-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--dsw-alias-label-secondary, #71717a);
    border-radius: 6px;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-details-close-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.12));
    color: var(--dsw-alias-label-primary, #18181b);
  }

  .copis-details-content-body {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 10px 12px;
    overflow: hidden;
  }

  .copis-workspace-search-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-radius: 8px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08));
    flex-shrink: 0;
    margin-bottom: 8px;
  }

  .copis-workspace-search-input {
    border: none;
    background: transparent;
    outline: none;
    font-size: 12px;
    width: 100%;
    color: var(--dsw-alias-label-primary, inherit);
  }

  .copis-workspace-refresh-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    color: var(--dsw-alias-label-tertiary, #a1a1aa);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 120ms ease;
  }

  .copis-workspace-refresh-btn:hover {
    color: var(--dsw-alias-label-primary, inherit);
  }

  .copis-tree-container {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .copis-tree-node-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 5px;
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: background-color 100ms ease;
  }

  .copis-tree-node-row:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.08));
  }

  .copis-tree-node-row[data-selected="true"] {
    background: rgba(255, 255, 255, 0.12) !important;
    color: #ffffff !important;
  }

  .copis-preview-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    gap: 8px;
    overflow: hidden;
  }

  .copis-preview-nav-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-radius: 6px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.08));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    font-size: 12px;
    flex-shrink: 0;
  }

  .copis-preview-btn {
    appearance: none;
    border: none;
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--dsw-alias-label-secondary, #71717a);
    transition: background-color 120ms ease, color 120ms ease;
  }

  .copis-preview-btn:hover {
    background: var(--dsw-alias-interactive-bg-hover, rgba(120, 120, 128, 0.15));
    color: var(--dsw-alias-label-primary, #18181b);
  }

  .copis-code-view-wrapper {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border-radius: 6px;
    background: var(--dsw-alias-input-bg, rgba(120, 120, 128, 0.04));
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.06));
    padding: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    line-height: 18px;
    white-space: pre;
  }
  /* 彻底屏蔽 DSH 原生旧版 DetailsPanel 遗留界面（旧的文件与改动 tab） */
  [class*="_2ctAZa_header"],
  [class*="_2ctAZa_root"] > div:first-child:not(.copis-inspector-tabbar) {
    display: none !important;
  }

  /* 彻底屏蔽 DSH 原生设置弹窗与遮罩层，统一由 Copis 全屏设置面板接管 */
  [class*="VOzbGW_panel"],
  [class*="VOzbGW_overlay"],
  [class*="VOzbGW_mask"],
  [class*="settingsArea"] [role="dialog"],
  [class*="SettingsArea"] [role="dialog"],
  [class*="SettingsPanel"],
  [class*="settingsPanel"] {
    display: none !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
`

function installCreationStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CREATION_STYLES_ID)) return

  const style = document.createElement('style')
  style.id = CREATION_STYLES_ID
  style.textContent = CREATION_UI_CSS
  document.head.appendChild(style)
}

export function isSettingsTarget(target: HTMLElement | null): boolean {
  if (!target) return false
  const btn = target.closest('button')
  if (!btn) return false

  // 1. 严格排除：Composer 内部、中间对话区、详情抽屉或消息流内部的任何按钮（如上下文用量圆环、模型选择、发送等），严禁误触发系统设置
  if (
    btn.closest(
      '[class*="composer"], [class*="Composer"], [class*="uV2eYG"], [class*="_centerCol"], [class*="centerCol"], [class*="chatArea"], [class*="messageList"], [class*="sessionView"], [class*="_detailsCol"]',
    )
  ) {
    return false
  }

  // 2. 限制作用域：系统设置按钮必须严格属于侧边栏容器（aside, SidebarRoot, footArea, settingsArea）
  const inSidebar = Boolean(
    btn.closest(
      'aside, [class*="SidebarRoot"], [class*="sidebar"], [class*="_sidebarCol"], [class*="footArea"], [class*="FootArea"], [class*="settingsArea"], [class*="SettingsArea"], .copis-creation-sidebar',
    ),
  )
  if (!inSidebar) {
    return false
  }

  // 3. 在侧边栏内，精确匹配设置入口：
  // 3.1 DSH settingsArea / triggerRow 容器内的设置按钮
  if (btn.closest('[class*="settingsArea"], [class*="SettingsArea"]')) return true
  if (btn.closest('[class*="triggerRow"], [class*="TriggerRow"]') && btn.getAttribute('aria-haspopup') === 'dialog') return true
  if (btn.matches('button[class*="trigger"][aria-haspopup="dialog"], button[class*="Trigger"][aria-haspopup="dialog"]')) return true

  // 3.2 侧边栏内 aria-label 或 title 包含设置/setting
  const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase()
  if (aria.includes('设置') || aria.includes('setting')) return true

  // 3.3 侧边栏内文本包含设置/setting
  const text = (btn.textContent || '').trim().toLowerCase()
  if (text.includes('设置') || text.includes('setting')) return true

  return false
}

function sendNavigation(view: CreationView, tab?: string): void {
  if (view && view !== 'conversations') {
    document.body?.classList.add('copis-subview-active')
    document.documentElement?.classList.add('copis-subview-active')
  } else {
    document.body?.classList.remove('copis-subview-active')
    document.documentElement?.classList.remove('copis-subview-active')
  }
  if (view === 'settings') {
    if (window.copisBridge?.openSettings) {
      window.copisBridge.openSettings()
      return
    }
    window.postMessage({ type: 'COPIS_OPEN_SETTINGS' }, '*')
    return
  }
  if (window.copisBridge?.navigate) {
    window.copisBridge.navigate(view, tab)
    return
  }
  window.postMessage({ type: 'COPIS_NAVIGATE', view, tab }, '*')
}

function sendSearchRequest(): void {
  window.dispatchEvent(new CustomEvent('COPIS_OPEN_SEARCH_MODAL'))
  if (window.copisBridge?.openSearch) {
    window.copisBridge.openSearch()
    return
  }
  window.postMessage({ type: 'COPIS_OPEN_SEARCH' }, '*')
}

function getFileIconColor(name: string): string {
  const ext = (name || '').split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return '#3178c6'
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return '#f59e0b'
    case 'vue':
      return '#42b883'
    case 'html':
    case 'htm':
      return '#e44d26'
    case 'css':
    case 'scss':
    case 'less':
      return '#06b6d4'
    case 'json':
      return '#eab308'
    case 'md':
    case 'markdown':
      return '#3b82f6'
    case 'py':
      return '#38bdf8'
    case 'rs':
      return '#f97316'
    case 'sh':
    case 'bash':
    case 'zsh':
      return '#22c55e'
    case 'yaml':
    case 'yml':
      return '#a855f7'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
    case 'ico':
      return '#ec4899'
    default:
      return 'var(--dsw-alias-label-tertiary, #a1a1aa)'
  }
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getInitialHiddenMenuIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    return window.copisBridge?.getHiddenMenuItems?.() ?? []
  } catch {
    return []
  }
}

function attachSidebarMenu(element: HTMLElement): void {
  const sidebar = (element.closest('[class*="_root"]') ??
    element.closest('[class*="SidebarRoot"]') ??
    element.closest('[class*="_sidebarCol"], [class*="sidebarCol"]') ??
    element.closest('aside')) as HTMLElement | null
  if (!sidebar) return

  sidebar.classList.add('copis-creation-sidebar')

  // 清理原生侧栏中可能遗留的旧版硬编码菜单节点（无 data-copis-placement），避免与独立插件菜单重复
  const legacySections = sidebar.querySelectorAll(
    '.copis-menu-section:not([data-copis-placement="before-workspaces"]), .copis-rail-menu-section:not([data-copis-placement="before-workspaces"])',
  )
  legacySections.forEach((el) => el.remove())

  const target =
    sidebar.querySelector('[class*="_regionArea"], [class*="regionArea"]') ??
    sidebar.querySelector('button[class*="_newSession"], button[class*="newSession"]')

  if (target && element.parentElement !== sidebar) {
    sidebar.insertBefore(element, target)
  }
}

let cachedCordisContext: CordisContext | null = null

export function CreationSidebarNavigation(props: {
  collapsed?: boolean
  width?: number
  wide?: boolean
  ctx?: CordisContext
}): ReactElement {
  const [activeView, setActiveView] = useState<CreationView>('conversations')
  const [hiddenMenuIds, setHiddenMenuIds] = useState<string[]>(getInitialHiddenMenuIds)
  const rootRef = useRef<HTMLDivElement>(null)
  const isSubviewActive = activeView !== 'conversations'
  const effectiveCtx = props.ctx ?? cachedCordisContext

  // 在子视图激活（记忆/知识库/日程表等）时，强制判定 wide 展开态，绝不渲染窄 rail
  const wide =
    isSubviewActive ||
    Boolean(props.wide) ||
    (!props.collapsed && (props.width === undefined || props.width >= 200))

  useLayoutEffect(() => {
    if (rootRef.current) {
      attachSidebarMenu(rootRef.current)
      const sidebar = rootRef.current.closest(
        '[class*="_root"], [class*="SidebarRoot"], [class*="_sidebarCol"], [class*="sidebarCol"], aside',
      ) as HTMLElement | null
      if (
        sidebar &&
        !isSubviewActive &&
        typeof document !== 'undefined' &&
        !document.body.classList.contains('copis-subview-active')
      ) {
        const w = sidebar.getBoundingClientRect().width
        if (w >= 200 && w <= 360 && window.copisBridge?.reportSidebarInfo) {
          window.copisBridge.reportSidebarInfo({ width: Math.round(w), wide: true })
        }
      }
    }
  }, [props.collapsed, props.width, hiddenMenuIds, activeView, isSubviewActive])

  // 当激活子功能视图时，DSH 原生视口宽度被收缩为 280px，DSH AppFrame 会将 narrow 判定为 true 并折叠侧栏。
  // 通过主动调用 ctx.layout.toggleSidebar()，将 narrowExpanded 翻转为 true，使得 DSH computeColumns 重新计算为宽态侧栏 (280px)，
  // 恢复原生“新会话”按钮、完整会话历史列表及完整菜单文本。
  useEffect(() => {
    if (!isSubviewActive) return

    let calling = false
    const expandIfCollapsed = () => {
      if (calling) return
      const frame = document.querySelector('[data-sidebar-collapsed]')
      const sidebar = rootRef.current?.closest(
        'aside.copis-creation-sidebar, aside.hHd-Xa_root, aside[class*="SidebarRoot"], aside',
      ) as HTMLElement | null

      const isCollapsed = Boolean(
        frame ||
        props.collapsed === true ||
        sidebar?.classList.contains('hHd-Xa_collapsed')
      ) && props.wide !== true

      if (isCollapsed && effectiveCtx?.layout?.toggleSidebar) {
        calling = true
        try {
          effectiveCtx.layout.toggleSidebar()
        } catch (err) {
          console.warn('[Copis Creation Web] 自动展开侧边栏失败:', err)
        } finally {
          setTimeout(() => {
            calling = false
          }, 60)
        }
      }
    }

    expandIfCollapsed()
    const timer1 = setTimeout(expandIfCollapsed, 60)
    const timer2 = setTimeout(expandIfCollapsed, 200)

    let observer: MutationObserver | null = null
    const frame = document.querySelector('[class*="_frame"], [class*="frame"]') || document.body
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => {
        expandIfCollapsed()
      })
      observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'class'] })
    }

    return () => {
      clearTimeout(timer1)
      clearTimeout(timer2)
      observer?.disconnect()
    }
  }, [isSubviewActive, props.collapsed, props.wide, effectiveCtx])

  // 当子视图激活时，原「新会话」按钮切换为「返回会话」，点击时拦截 startSession 并平滑返回原会话
  useEffect(() => {
    const handleTopButtonClick = (event: MouseEvent) => {
      if (!isSubviewActive) return
      const target = event.target as HTMLElement | null
      const topBtn = target?.closest('button[class*="_newSession"], button[class*="newSession"]')
      if (!topBtn) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setActiveView('conversations')
      document.body?.classList.remove('copis-subview-active')
      document.documentElement?.classList.remove('copis-subview-active')
      sendNavigation('conversations')
    }

    document.addEventListener('click', handleTopButtonClick, true)
    return () => document.removeEventListener('click', handleTopButtonClick, true)
  }, [isSubviewActive])

  // 动态同步上方「新会话 / 返回会话」按钮属性与语义提示
  useEffect(() => {
    const topBtn = document.querySelector('button[class*="_newSession"], button[class*="newSession"]') as HTMLButtonElement | null
    if (!topBtn) return

    if (isSubviewActive) {
      topBtn.setAttribute('data-copis-return-button', 'true')
      topBtn.setAttribute('title', '返回会话 (Esc)')
      topBtn.setAttribute('aria-label', '返回会话 (Esc)')
    } else {
      topBtn.removeAttribute('data-copis-return-button')
      topBtn.setAttribute('title', '新建会话')
      topBtn.setAttribute('aria-label', '新建会话')
    }
  }, [isSubviewActive])

  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname.toLowerCase()
      if (path.includes('planning')) setActiveView('planning')
      else if (path.includes('automations')) setActiveView('automations')
      else if (path.includes('memory')) setActiveView('memory')
      else if (path.includes('knowledge')) setActiveView('knowledge')
      else if (path.includes('expert-team')) setActiveView('expert-team')
      else if (path.includes('agent-skills')) setActiveView('agent-skills')
      else if (path.includes('fund-stock')) setActiveView('fund-stock')
      else setActiveView('conversations')
    }

    handlePopState()
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  useEffect(() => {
    const handleActiveViewMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === 'object') {
        const d = event.data as { type?: string; view?: string; subview?: string | null }
        if (d.type === 'COPIS_ACTIVE_VIEW_CHANGE') {
          if (d.view === 'conversations') {
            setActiveView('conversations')
            document.body?.classList.remove('copis-subview-active')
            document.documentElement?.classList.remove('copis-subview-active')
          } else if (d.view) {
            setActiveView(d.view as CreationView)
            document.body?.classList.add('copis-subview-active')
            document.documentElement?.classList.add('copis-subview-active')
          }
        } else if (d.type === 'COPIS_SUBVIEW_CHANGE') {
          if (!d.subview) {
            setActiveView('conversations')
            document.body?.classList.remove('copis-subview-active')
            document.documentElement?.classList.remove('copis-subview-active')
          } else {
            setActiveView(d.subview as CreationView)
            document.body?.classList.add('copis-subview-active')
            document.documentElement?.classList.add('copis-subview-active')
          }
        }
      }
    }

    window.addEventListener('message', handleActiveViewMessage)
    return () => window.removeEventListener('message', handleActiveViewMessage)
  }, [])

  useEffect(() => {
    const handleHiddenItemsChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ hiddenMenuIds?: string[] }>
      if (Array.isArray(customEvent.detail?.hiddenMenuIds)) {
        setHiddenMenuIds(customEvent.detail.hiddenMenuIds)
      } else {
        setHiddenMenuIds(getInitialHiddenMenuIds())
      }
    }

    window.addEventListener('COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED', handleHiddenItemsChange)
    return () => window.removeEventListener('COPIS_HIDDEN_SIDEBAR_MENU_ITEMS_CHANGED', handleHiddenItemsChange)
  }, [])

  useEffect(() => {
    const openCopisSettings = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!isSettingsTarget(target)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setActiveView('settings')
      sendNavigation('settings')
    }

    document.addEventListener('click', openCopisSettings, true)
    return () => document.removeEventListener('click', openCopisSettings, true)
  }, [])

  const selectItem = (item: SidebarMenuItem) => {
    if (item.action === 'search') {
      sendSearchRequest()
      return
    }
    if (!item.view) return
    setActiveView(item.view)
    document.body?.classList.add('copis-subview-active')
    document.documentElement?.classList.add('copis-subview-active')
    // 切换至子视图时，若工作区抽屉处于展开态，自动折叠以保持全屏整洁
    if (document.body?.classList.contains('copis-details-drawer-open')) {
      window.dispatchEvent(new CustomEvent('COPIS_TOGGLE_WORKSPACE_DRAWER'))
    }
    sendNavigation(item.view, item.tab)
  }

  const handleHideMenuItem = (menuId: string) => {
    setHiddenMenuIds((prev) => Array.from(new Set([...prev, menuId])))
    if (window.copisBridge?.hideMenuItem) {
      window.copisBridge.hideMenuItem(menuId)
    }
  }

  const visibleMenuItems = SIDEBAR_MENU_ITEMS.filter((item) => !hiddenMenuIds.includes(item.id))

  if (!wide) {
    return (
      <div ref={rootRef} className="copis-rail-menu-section" data-copis-placement="before-workspaces">
        {visibleMenuItems.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              className="copis-rail-menu-item"
              data-copis-menu-id={item.id}
              data-active={item.view === activeView ? 'true' : 'false'}
              aria-label={item.label}
              title={item.label}
              onClick={() => selectItem(item)}
            >
              <Icon size={18} strokeWidth={1.8} />
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="copis-menu-section" data-copis-placement="before-workspaces">
      {visibleMenuItems.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            type="button"
            className="copis-menu-item"
            data-copis-menu-id={item.id}
            data-active={item.view === activeView ? 'true' : 'false'}
            onClick={() => selectItem(item)}
          >
            <Icon size={16} strokeWidth={1.8} />
            <span>{item.label}</span>
            {item.badge && (
              <span
                className={`copis-menu-badge ${
                  item.badge === 'BETA' ? 'copis-menu-badge-beta' : 'copis-menu-badge-flexible'
                }`}
              >
                {item.badge}
              </span>
            )}
            <button
              type="button"
              className="copis-dsh-menu-hide-btn"
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                handleHideMenuItem(item.id)
              }}
              aria-label={`隐藏${item.label}`}
              title="隐藏此菜单"
            >
              隐藏
            </button>
          </button>
        )
      })}
    </div>
  )
}

/** 中部对话区右上角操作按钮（工作区文件操作） */
export function CopisHeaderUtilities(props: { ctx: CordisContext }): ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false)

  // 检测全功能 Inspector 抽屉是否处于展开状态（通过 body.copis-details-drawer-open）
  useEffect(() => {
    const checkDetailsState = () => {
      if (typeof document === 'undefined') return
      const isDrawerOpen = Boolean(document.body?.classList.contains('copis-details-drawer-open'))
      setDetailsOpen(isDrawerOpen)
    }

    checkDetailsState()
    const observer = new MutationObserver(checkDetailsState)
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    })

    const handleToggleEvent = () => {
      requestAnimationFrame(checkDetailsState)
    }
    window.addEventListener('COPIS_TOGGLE_WORKSPACE_DRAWER', handleToggleEvent)

    return () => {
      observer.disconnect()
      window.removeEventListener('COPIS_TOGGLE_WORKSPACE_DRAWER', handleToggleEvent)
    }
  }, [])

  const handleToggleWorkspaceDetails = () => {
    if (typeof document === 'undefined') return
    const isDrawerOpen = Boolean(document.body?.classList.contains('copis-details-drawer-open'))

    // 若 DSH 原生旧 detailsCol 处于展开状态，将其收起以释放主视图宽度
    const detailsCol = document.querySelector('[class*="detailsCol"], [class*="_detailsCol"]')
    const isCollapsed = Boolean(document.querySelector('[data-details-collapsed]'))
    if (detailsCol && !isCollapsed) {
      props.ctx.layout?.closeDetails()
    }

    // 统一唤起全新的全功能 Inspector 抽屉（文件、侧边聊天、团队）
    window.dispatchEvent(new CustomEvent('COPIS_TOGGLE_WORKSPACE_DRAWER'))
    setDetailsOpen(!isDrawerOpen)
  }

  return (
    <div className="copis-header-utilities-bar">
      {/* 工作区文件操作展开/折叠按钮（与 Agent 模式对齐，单个 icon 图标控制） */}
      <button
        type="button"
        className="copis-header-action-btn copis-header-btn-workspace"
        data-active={detailsOpen ? 'true' : 'false'}
        onClick={handleToggleWorkspaceDetails}
        title={detailsOpen ? '折叠工作区文件面板' : '展开工作区文件面板'}
        aria-label={detailsOpen ? '折叠工作区文件面板' : '展开工作区文件面板'}
      >
        {detailsOpen ? (
          <PanelRightClose size={15} strokeWidth={1.8} />
        ) : (
          <PanelRight size={15} strokeWidth={1.8} />
        )}
      </button>
    </div>
  )
}

/**
 * 右侧工作区全功能 Inspector 检查器面板
 * 移植自 cc-sandbox，包含：
 * 1. 文件（Files）：工作区文件树过滤 + 双栏代码高亮/图片就地预览；
 * 2. 侧边聊天（Side Chat）：轻量独立问答对话流 + 预设快捷提问；
 * 3. 团队（Team）：主智能体/专家成员状态（处理中/空闲/待命）+ 任务编排看板 + 历史子会话回溯。
 */
export { CopisInspectorPanel } from './inspector/CopisInspectorPanel'

/** 向后兼容的 CopisDetailsPanel 别名，代理至全功能 CopisInspectorPanel */
export function CopisDetailsPanel(props: {
  sessionId?: string
  ctx: CordisContext
  renderSlot?: (name: string, props: any) => ReactElement | null
  closeDetails?: () => void
}): ReactElement {
  return <CopisInspectorPanel {...props} />
}

interface CopisSearchItem {
  id: string
  title: string
  source: 'creation' | 'agent'
  snippet?: string
  matchStart?: number
  matchLength?: number
  updatedAt?: number
}

function HighlightSearchText({ text, query }: { text: string; query: string }): ReactElement {
  if (!query || !query.trim()) return <>{text}</>
  const trimmed = query.trim()
  const lowerText = text.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  const parts: ReactElement[] = []
  let lastIndex = 0
  let idx = lowerText.indexOf(lowerQuery)
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, idx)}</span>)
    }
    parts.push(
      <mark
        key={`m-${idx}`}
        style={{
          background: 'rgba(255, 255, 255, 0.18)',
          color: '#ffffff',
          borderRadius: 2,
          padding: '0 2px',
          fontWeight: 600,
        }}
      >
        {text.slice(idx, idx + trimmed.length)}
      </mark>
    )
    lastIndex = idx + trimmed.length
    idx = lowerText.indexOf(lowerQuery, lastIndex)
  }
  if (lastIndex < text.length) {
    parts.push(<span key={`end-${lastIndex}`}>{text.slice(lastIndex)}</span>)
  }
  return <>{parts}</>
}

/** 创造模式内建全局搜索浮层：保持底层 DSH 视图完全可见，绝不触发全黑全白 */
export function CopisSearchModal(props: {
  open: boolean
  onClose: () => void
  ctx: CordisContext
}): ReactElement | null {
  const [query, setQuery] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [titleResults, setTitleResults] = useState<CopisSearchItem[]>([])
  const [contentResults, setContentResults] = useState<CopisSearchItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const searchTokenRef = useRef(0)

  // 聚焦输入框
  useEffect(() => {
    if (props.open) {
      setTimeout(() => {
        inputRef.current?.focus()
      }, 50)
    } else {
      setQuery('')
      setCommittedQuery('')
      setTitleResults([])
      setContentResults([])
      setHasSearched(false)
      setSelectedIndex(0)
    }
  }, [props.open])

  // 执行搜索
  const runSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) {
      setTitleResults([])
      setContentResults([])
      setHasSearched(false)
      setCommittedQuery('')
      return
    }

    const token = ++searchTokenRef.current
    setCommittedQuery(q)
    setHasSearched(true)
    setLoading(true)
    setSelectedIndex(0)

    const qLower = q.toLowerCase()
    const titles: CopisSearchItem[] = []

    // 1. 检索当前创造模式本地会话列表
    try {
      const listSnapshot = props.ctx.sessions?.list?.getSnapshot()
      if (listSnapshot?.byId) {
        for (const [id, s] of Object.entries(listSnapshot.byId as Record<string, any>)) {
          const t = s?.title || '新会话'
          if (t.toLowerCase().includes(qLower)) {
            titles.push({
              id,
              title: t,
              source: 'creation',
              updatedAt: s?.updatedAt || s?.createdAt || 0,
            })
          }
        }
      }
    } catch (err) {
      console.warn('[CopisSearchModal] 读取 DSH 会话失败:', err)
    }

    // 2. 检索 Agent 模式历史会话标题
    try {
      if (window.copisBridge?.getAgentSessions) {
        const agentSessions = await window.copisBridge.getAgentSessions()
        if (token === searchTokenRef.current && Array.isArray(agentSessions)) {
          for (const s of agentSessions) {
            if (s?.title && s.title.toLowerCase().includes(qLower)) {
              titles.push({
                id: s.id,
                title: s.title,
                source: 'agent',
                updatedAt: s.updatedAt || 0,
              })
            }
          }
        }
      }
    } catch (err) {
      console.warn('[CopisSearchModal] 读取 Agent 会话失败:', err)
    }

    if (token !== searchTokenRef.current) return
    titles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    setTitleResults(titles)

    // 3. 检索消息全文
    try {
      if (window.copisBridge?.searchAgentSessionMessages) {
        const messageResults = await window.copisBridge.searchAgentSessionMessages(q)
        if (token === searchTokenRef.current && Array.isArray(messageResults)) {
          const titleIds = new Set(titles.map((t) => t.id))
          const contents: CopisSearchItem[] = messageResults
            .filter((r) => !titleIds.has(r.sessionId))
            .map((r) => ({
              id: r.sessionId,
              title: r.sessionTitle,
              source: 'agent',
              snippet: r.snippet,
              matchStart: r.matchStart,
              matchLength: r.matchLength,
            }))
          setContentResults(contents)
        }
      }
    } catch (err) {
      console.warn('[CopisSearchModal] 搜索消息全文失败:', err)
    } finally {
      if (token === searchTokenRef.current) {
        setLoading(false)
      }
    }
  }, [query, props.ctx.sessions])

  const allResults = useMemo(
    () => [...titleResults, ...contentResults],
    [titleResults, contentResults],
  )

  const navigateToResult = useCallback((item: CopisSearchItem) => {
    props.onClose()
    if (item.source === 'creation') {
      try {
        if (props.ctx.sessions?.open) {
          props.ctx.sessions.open(item.id)
        } else if (props.ctx.sessions?.select) {
          props.ctx.sessions.select(item.id)
        } else {
          const el = document.querySelector(`[data-session-id="${item.id}"]`) as HTMLElement | null
          el?.click()
        }
      } catch {
        const el = document.querySelector(`[data-session-id="${item.id}"]`) as HTMLElement | null
        el?.click()
      }
    } else {
      if (window.copisBridge?.openSession) {
        window.copisBridge.openSession('agent', item.id, item.title)
      } else if (window.copisBridge?.switchMode) {
        window.copisBridge.switchMode('agent')
      }
    }
  }, [props.ctx.sessions, props.onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (allResults.length > 0 ? (prev + 1) % allResults.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (allResults.length > 0 ? (prev - 1 + allResults.length) % allResults.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isComposingRef.current) return
      if (query.trim() !== committedQuery || !hasSearched) {
        void runSearch()
      } else if (allResults[selectedIndex]) {
        navigateToResult(allResults[selectedIndex])
      }
    }
  }, [allResults, committedQuery, hasSearched, navigateToResult, props, query, runSearch, selectedIndex])

  if (!props.open) return null

  const isQueryDirty = query.trim() !== committedQuery

  return (
    <div
      className="copis-search-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose()
        }
      }}
    >
      <div className="copis-search-modal-card" onKeyDown={handleKeyDown}>
        {/* 顶部搜索输入框 */}
        <div className="copis-search-input-row">
          <Search size={16} style={{ color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            type="text"
            className="copis-search-main-input"
            value={query}
            placeholder="输入关键词，按 Enter 或点击搜索"
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false
            }}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                setCommittedQuery('')
                setTitleResults([])
                setContentResults([])
                setHasSearched(false)
                setSelectedIndex(0)
                inputRef.current?.focus()
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--dsw-alias-label-tertiary, #a1a1aa)',
                padding: '2px',
                display: 'inline-flex',
                alignItems: 'center',
              }}
              title="清空"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            className="copis-search-submit-btn"
            disabled={!query.trim() || loading}
            onClick={() => void runSearch()}
          >
            {loading ? <Loader2 size={13} className="copis-spin" /> : <Search size={13} />}
            <span>搜索</span>
          </button>
        </div>

        {/* 搜索结果区域 */}
        <div className="copis-search-results-list">
          {!hasSearched && (
            <div style={{ padding: '36px 16px', textAlign: 'center', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
              输入关键词后按 Enter 或点击搜索开始查找
            </div>
          )}

          {hasSearched && loading && allResults.length === 0 && (
            <div style={{ padding: '36px 16px', textAlign: 'center', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
              <Loader2 size={14} className="copis-spin" />
              <span>正在搜索...</span>
            </div>
          )}

          {hasSearched && !loading && allResults.length === 0 && (
            <div style={{ padding: '36px 16px', textAlign: 'center', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
              未找到与 "{committedQuery}" 匹配的会话内容
            </div>
          )}

          {titleResults.length > 0 && (
            <div>
              <div style={{ padding: '6px 14px 2px', fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', textTransform: 'uppercase' }}>
                会话匹配 ({titleResults.length})
              </div>
              {titleResults.map((item, idx) => (
                <button
                  key={`title-${item.id}-${idx}`}
                  type="button"
                  className="copis-search-item-row"
                  data-selected={selectedIndex === idx ? 'true' : 'false'}
                  onClick={() => navigateToResult(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {item.source === 'creation' ? (
                    <span className="copis-search-badge-creation">创造</span>
                  ) : (
                    <span className="copis-search-badge-agent">Agent</span>
                  )}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', fontWeight: 500 }}>
                    <HighlightSearchText text={item.title} query={committedQuery} />
                  </span>
                </button>
              ))}
            </div>
          )}

          {contentResults.length > 0 && (
            <div style={{ borderTop: '0.5px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.08))', marginTop: '4px', paddingTop: '4px' }}>
              <div style={{ padding: '6px 14px 2px', fontSize: '11px', fontWeight: 600, color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', textTransform: 'uppercase' }}>
                消息内容匹配 ({contentResults.length})
              </div>
              {contentResults.map((item, idx) => {
                const globalIdx = titleResults.length + idx
                return (
                  <button
                    key={`content-${item.id}-${idx}`}
                    type="button"
                    className="copis-search-item-row"
                    data-selected={selectedIndex === globalIdx ? 'true' : 'false'}
                    onClick={() => navigateToResult(item)}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '3px' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                      <span className="copis-search-badge-agent">Agent</span>
                      <span style={{ fontSize: '12px', fontWeight: 500, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </span>
                    </div>
                    {item.snippet && (
                      <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #71717a)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', paddingLeft: '4px' }}>
                        <HighlightSearchText text={item.snippet} query={committedQuery} />
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* 底部快捷键提示 */}
        <div className="copis-search-footer">
          <span>↵ {isQueryDirty || !hasSearched ? '搜索' : '打开'}</span>
          <span>↑↓ 选择</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}

const DEFAULT_DRAWER_WIDTH = 500
const MIN_DRAWER_WIDTH = 360
const MAX_DRAWER_WIDTH = 840

function getInitialDrawerWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_DRAWER_WIDTH
  try {
    const saved = localStorage.getItem('copis_creation_inspector_width')
    if (saved) {
      const parsed = parseInt(saved, 10)
      if (!isNaN(parsed) && parsed >= MIN_DRAWER_WIDTH && parsed <= MAX_DRAWER_WIDTH) {
        return parsed
      }
    }
  } catch {}
  return DEFAULT_DRAWER_WIDTH
}

export function CopisShellOverlayManager(props: { ctx: CordisContext }): ReactElement {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerWidth, setDrawerWidth] = useState<number>(getInitialDrawerWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [hasSessionHeader, setHasSessionHeader] = useState(false)
  const [isSubviewActive, setIsSubviewActive] = useState(() => {
    if (typeof document === 'undefined') return false
    return (
      document.body?.classList.contains('copis-subview-active') ||
      document.documentElement?.classList.contains('copis-subview-active')
    )
  })

  // 监听全局切换抽屉事件
  useEffect(() => {
    const handleToggle = () => setDrawerOpen((prev) => !prev)
    window.addEventListener('COPIS_TOGGLE_WORKSPACE_DRAWER', handleToggle)
    return () => window.removeEventListener('COPIS_TOGGLE_WORKSPACE_DRAWER', handleToggle)
  }, [])

  // 抽屉展开状态与宽度同步至 body class 与 CSS 变量（驱动中部聊天区 margin-right 挤压平滑并列）
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (drawerOpen) {
      document.body.classList.add('copis-details-drawer-open')
      document.documentElement.classList.add('copis-details-drawer-open')
      document.documentElement.style.setProperty('--copis-inspector-width', `${drawerWidth}px`)
    } else {
      document.body.classList.remove('copis-details-drawer-open')
      document.documentElement.classList.remove('copis-details-drawer-open')
    }
  }, [drawerOpen, drawerWidth])

  // 左边缘拖拽调整抽屉宽度
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setIsResizing(true)
    document.body.classList.add('copis-inspector-resizing')
    const startX = e.clientX
    const startWidth = drawerWidth

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = startX - moveEvent.clientX
      const maxAllowed = Math.max(MIN_DRAWER_WIDTH, window.innerWidth - 360)
      const newWidth = Math.max(MIN_DRAWER_WIDTH, Math.min(maxAllowed, startWidth + deltaX))
      setDrawerWidth(newWidth)
      document.documentElement.style.setProperty('--copis-inspector-width', `${newWidth}px`)
    }

    const onPointerUp = () => {
      setIsResizing(false)
      document.body.classList.remove('copis-inspector-resizing')
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      try {
        localStorage.setItem('copis_creation_inspector_width', String(drawerWidth))
      } catch {}
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }, [drawerWidth])

  // 监听搜索浮层唤起事件与 Cmd+K / Ctrl+K 快捷键
  useEffect(() => {
    const handleOpenSearch = () => setSearchOpen(true)
    const handleMessage = (event: MessageEvent) => {
      if (
        event.data &&
        typeof event.data === 'object' &&
        (event.data.type === 'COPIS_OPEN_SEARCH_MODAL' || event.data.type === 'COPIS_OPEN_SEARCH')
      ) {
        setSearchOpen(true)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }

    window.addEventListener('COPIS_OPEN_SEARCH_MODAL', handleOpenSearch)
    window.addEventListener('message', handleMessage)
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('COPIS_OPEN_SEARCH_MODAL', handleOpenSearch)
      window.removeEventListener('message', handleMessage)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // Esc 快捷键关闭抽屉
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drawerOpen) {
        e.preventDefault()
        setDrawerOpen(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [drawerOpen])

  // 检测当前是否已渲染会话内的 Header，以及子视图激活状态（激活时隐藏 overlay 浮动按钮，避免重复与遮挡）
  useEffect(() => {
    const checkState = () => {
      if (typeof document === 'undefined') return
      const headerItem = document.querySelector(
        '.copis-header-utilities-bar:not(.copis-hero-utilities-overlay .copis-header-utilities-bar)',
      )
      setHasSessionHeader(Boolean(headerItem))
      setIsSubviewActive(
        document.body?.classList.contains('copis-subview-active') ||
        document.documentElement?.classList.contains('copis-subview-active'),
      )
    }
    checkState()
    const observer = new MutationObserver(checkState)
    observer.observe(document.body, { attributes: true, childList: true, subtree: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return (
    <>
      {/* 初始欢迎页（无会话 Header 且非子视图激活时）右上角常驻操作栏 */}
      {!hasSessionHeader && !isSubviewActive && (
        <div className="copis-hero-utilities-overlay">
          <CopisHeaderUtilities ctx={props.ctx} />
        </div>
      )}

      {/* 右侧全局工作区多页签 Inspector 抽屉（推入式并列滑入，彻底移除全屏遮罩） */}
      <div
        className="copis-details-drawer-root"
        data-state={drawerOpen ? 'open' : 'closed'}
        aria-hidden={!drawerOpen}
      >
        <div
          className="copis-inspector-resize-handle"
          onPointerDown={handleResizeStart}
          data-resizing={isResizing ? 'true' : 'false'}
          title="按住拖拽调整侧边栏宽度"
        />
        <CopisInspectorPanel
          ctx={props.ctx}
          closeDetails={() => setDrawerOpen(false)}
        />
      </div>

      {/* 内建全局搜索浮层 */}
      {searchOpen && (
        <CopisSearchModal
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          ctx={props.ctx}
        />
      )}
    </>
  )
}

export const inject = ['slots', 'layout', 'sessions', 'workspaces']

export function apply(ctx: CordisContext): void {
  cachedCordisContext = ctx
  console.log('[Copis Creation Web] 客户端插件正在激活...', ctx)
  installCreationStyles()

  // 1. 侧边栏底部导航
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'copis-creation-sidebar', order: -100 },
      (props) => <CreationSidebarNavigation {...props} ctx={ctx} />,
    ),
  )

  // 2. 中部对话区右上角操作项：工作区文件展开
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'copis-session-header-utilities',
        order: 100,
      },
      (props) => <CopisHeaderUtilities {...props} ctx={ctx} />,
    ),
  )

  // 3. 全局根层 overlay：在欢迎屏展示右上角操作栏与全局工作区文件抽屉
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'copis-shell-overlay-manager',
        order: 100,
      },
      () => <CopisShellOverlayManager ctx={ctx} />,
    ),
  )

  console.log('[Copis Creation Web] 客户端插件插槽注入完成')
}
