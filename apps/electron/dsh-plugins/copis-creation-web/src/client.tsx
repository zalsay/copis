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
import { CopisLogoIcon } from '../../../src/renderer/components/ui/copis-logo-icon'

interface LayoutController {
  openDetails(): void
  closeDetails(): void
  toggleDetails?(): void
  toggleSidebar(): void
}

interface SessionState {
  id: string
  cwd?: string
  title?: string
  blank?: boolean
}

interface SessionsService {
  list: {
    getSnapshot(): {
      current?: string
      byId: Record<string, SessionState>
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
  | 'settings'

interface SidebarMenuItem {
  id: string
  label: string
  icon: LucideIcon
  view?: Exclude<CreationView, 'conversations' | 'settings'>
  tab?: string
  action?: 'search'
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15)) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
    font-weight: 600 !important;
  }

  .copis-menu-item svg {
    flex: none;
    width: 15px;
    height: 15px;
    color: var(--dsw-alias-label-secondary, #71717a);
  }

  .copis-menu-item[data-active="true"] svg {
    color: var(--creation-ui-primary, #6c00cc) !important;
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15)) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
  }

  .copis-rail-menu-item svg {
    width: 16px;
    height: 16px;
  }

  button[class*="_newSession"],
  button[class*="newSession"] {
    border-radius: 7px !important;
    font-size: 14px !important;
  }

  [class*="sessionRow"],
  [class*="SessionRow"] {
    border-radius: 7px !important;
    font-size: 14px !important;
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

  body.copis-subview-active .hHd-Xa_root,
  body.copis-subview-active [class*="_root"],
  body.copis-subview-active [class*="SidebarRoot"],
  body.copis-subview-active aside {
    width: 100% !important;
    padding: 6px var(--dsh-sidebar-inline-padding, 12px) !important;
  }

  /* 当子视图激活时，原「新会话」按钮无缝切换为「返回会话」按钮 */
  body.copis-subview-active button[class*="_newSession"],
  body.copis-subview-active button[class*="newSession"] {
    display: flex !important;
    align-items: center !important;
    width: 100% !important;
    height: 36px !important;
    margin: 0 0 12px !important;
    padding: 0 12px !important;
    gap: 8px !important;
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12)) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
    border: 1px solid var(--creation-ui-primary-background, rgba(108, 0, 204, 0.25)) !important;
    border-radius: 7px !important;
    align-self: stretch !important;
    cursor: pointer !important;
    transition: background-color 150ms ease, border-color 150ms ease !important;
    box-sizing: border-box !important;
  }

  body.copis-subview-active button[class*="_newSession"]:hover,
  body.copis-subview-active button[class*="newSession"]:hover {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.2)) !important;
    border-color: var(--creation-ui-primary, #6c00cc) !important;
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
    margin-left: 0 !important;
    margin-right: 0 !important;
    padding-left: 0 !important;
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

  .copis-header-btn-agent {
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
  }

  .copis-header-btn-workspace[data-active="true"] {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15)) !important;
    border-color: var(--creation-ui-primary, #6c00cc) !important;
    color: var(--creation-ui-primary, #6c00cc) !important;
  }

  /* 右侧工作区文件抽屉样式 */
  .copis-details-drawer-root {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 380px;
    max-width: calc(100vw - 60px);
    z-index: 100;
    background: var(--dsw-alias-bg-base, #ffffff);
    border-left: 1px solid var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.1));
    box-shadow: -6px 0 24px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    animation: copis-drawer-slide-in 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes copis-drawer-slide-in {
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
  }

  .copis-details-drawer-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 99;
    background: rgba(0, 0, 0, 0.15);
    backdrop-filter: blur(1px);
    animation: copis-drawer-fade-in 160ms ease;
  }

  @keyframes copis-drawer-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
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
    background: var(--creation-ui-primary, #6c00cc);
    color: #ffffff;
    border: none;
    cursor: pointer;
    transition: opacity 120ms ease;
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.08));
  }

  .copis-search-badge-creation {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12));
    color: var(--creation-ui-primary, #6c00cc);
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

  /* 右侧文件操作区面板样式 */
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
    background: var(--dsw-alias-bg-base, #ffffff);
    color: var(--dsw-alias-label-primary, #18181b);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
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
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.12));
    color: var(--creation-ui-primary, #6c00cc);
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
  // 1. DSH settingsArea / triggerRow 容器内的设置按钮
  if (btn.closest('[class*="settingsArea"], [class*="SettingsArea"]')) return true
  if (btn.closest('[class*="triggerRow"], [class*="TriggerRow"]') && btn.getAttribute('aria-haspopup') === 'dialog') return true
  if (btn.matches('button[class*="trigger"][aria-haspopup="dialog"], button[class*="Trigger"][aria-haspopup="dialog"]')) return true
  // 2. aria-label 或 title 包含设置/setting
  const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase()
  if (aria.includes('设置') || aria.includes('setting')) return true
  // 3. 侧边栏/底部按钮文字包含设置/setting
  const text = (btn.textContent || '').trim().toLowerCase()
  if (text.includes('设置') || text.includes('setting')) {
    if (btn.closest('[class*="footArea"], [class*="FootArea"], [class*="SidebarRoot"], [class*="_root"], aside')) {
      return true
    }
  }
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

function handleSwitchToAgent(): void {
  if (window.copisBridge?.switchMode) {
    window.copisBridge.switchMode('agent')
  }
  window.postMessage({ type: 'COPIS_SWITCH_MODE', mode: 'agent' }, '*')
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
        '[class*="_root"], [class*="SidebarRoot"], [class*="_sidebarCol"], [class*="sidebarCol"], aside',
      ) as HTMLElement | null

      const isCollapsed = Boolean(
        frame ||
        props.collapsed === true ||
        props.wide === false ||
        sidebar?.classList.contains('hHd-Xa_collapsed') ||
        sidebar?.matches('[class*="_collapsed"], [class*="collapsed"]'),
      )

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

/** 中部对话区右上角操作按钮（切换回 Agent 模式 + 工作区文件操作） */
export function CopisHeaderUtilities(props: { ctx: CordisContext }): ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false)

  // 检测右侧面板或全局工作区抽屉是否处于展开状态
  useEffect(() => {
    const checkDetailsState = () => {
      if (typeof document === 'undefined') return
      const isDrawerOpen = Boolean(document.querySelector('.copis-details-drawer-root'))
      const detailsCol = document.querySelector('[class*="detailsCol"], [class*="_detailsCol"]')
      const isCollapsed = Boolean(document.querySelector('[data-details-collapsed]'))

      if (isDrawerOpen) {
        setDetailsOpen(true)
      } else if (detailsCol) {
        setDetailsOpen(!isCollapsed)
      } else {
        setDetailsOpen(false)
      }
    }

    checkDetailsState()
    const observer = new MutationObserver(checkDetailsState)
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-details-collapsed'],
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
    const detailsCol = document.querySelector('[class*="detailsCol"], [class*="_detailsCol"]')
    const isDrawerOpen = Boolean(document.querySelector('.copis-details-drawer-root'))
    const isCollapsed = Boolean(document.querySelector('[data-details-collapsed]'))

    if (detailsCol) {
      if (isCollapsed) {
        props.ctx.layout?.openDetails()
        setDetailsOpen(true)
      } else {
        props.ctx.layout?.closeDetails()
        setDetailsOpen(false)
      }
    } else {
      window.dispatchEvent(new CustomEvent('COPIS_TOGGLE_WORKSPACE_DRAWER'))
      setDetailsOpen(!isDrawerOpen)
    }
  }

  return (
    <div className="copis-header-utilities-bar">
      {/* 切换回 Agent 模式按钮 */}
      <button
        type="button"
        className="copis-header-action-btn copis-header-btn-agent"
        onClick={handleSwitchToAgent}
        title="切换回 Agent 模式"
        aria-label="返回 Agent 模式"
      >
        <CopisLogoIcon size={14} style={{ color: 'var(--ui-primary, #f09a43)', flexShrink: 0 }} />
        <span>Agent 模式</span>
      </button>

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

/** 右侧文件操作面板（工作区文件树 + 文件原地预览） */
export function CopisDetailsPanel(props: {
  sessionId?: string
  ctx: CordisContext
  renderSlot?: (name: string, props: any) => ReactElement | null
  closeDetails?: () => void
}): ReactElement {
  const [activeTab, setActiveTab] = useState<'files' | 'preview' | 'tool'>('files')
  const [filterText, setFilterText] = useState('')
  const [rootEntries, setRootEntries] = useState<DirectoryEntry[]>([])
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set())
  const [childrenMap, setChildrenMap] = useState<Map<string, DirectoryEntry[]>>(() => new Map())
  const [loadingMap, setLoadingMap] = useState<Map<string, boolean>>(() => new Map())
  const [isRootLoading, setIsRootLoading] = useState(false)
  const [refreshCount, setRefreshCount] = useState(0)

  const [previewingFile, setPreviewingFile] = useState<DirectoryEntry | null>(null)
  const [previewState, setPreviewState] = useState<{
    loading: boolean
    content: string
    error: string | null
    isImage: boolean
    imageUrl: string
  }>({
    loading: false,
    content: '',
    error: null,
    isImage: false,
    imageUrl: '',
  })
  const [copied, setCopied] = useState(false)

  // 获得当前工作区 CWD 路径
  const sessionCwd = useMemo(() => {
    const listSnapshot = props.ctx.sessions?.list?.getSnapshot()
    const targetSessionId = props.sessionId || listSnapshot?.current
    if (targetSessionId && listSnapshot?.byId[targetSessionId]) {
      return listSnapshot.byId[targetSessionId].cwd
    }
    return undefined
  }, [props.sessionId, props.ctx.sessions])

  // 加载工作区根目录条目
  useEffect(() => {
    if (!sessionCwd) return
    let cancelled = false
    setIsRootLoading(true)

    if (window.copisBridge?.listDirectory) {
      window.copisBridge
        .listDirectory(undefined, sessionCwd)
        .then((entries) => {
          if (!cancelled) {
            setRootEntries(Array.isArray(entries) ? entries : [])
            setIsRootLoading(false)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRootEntries([])
            setIsRootLoading(false)
          }
        })
    } else {
      setIsRootLoading(false)
    }

    return () => {
      cancelled = true
    }
  }, [sessionCwd, refreshCount])

  // 展开 / 折叠文件夹并按需加载子目录
  const toggleFolder = (folderPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(folderPath)) {
        next.delete(folderPath)
      } else {
        next.add(folderPath)
        if (!childrenMap.has(folderPath)) {
          setLoadingMap((lm) => new Map(lm).set(folderPath, true))
          if (window.copisBridge?.listDirectory) {
            window.copisBridge
              .listDirectory(folderPath, sessionCwd)
              .then((kids) => {
                setChildrenMap((cm) => new Map(cm).set(folderPath, Array.isArray(kids) ? kids : []))
                setLoadingMap((lm) => {
                  const n = new Map(lm)
                  n.delete(folderPath)
                  return n
                })
              })
              .catch(() => {
                setChildrenMap((cm) => new Map(cm).set(folderPath, []))
                setLoadingMap((lm) => {
                  const n = new Map(lm)
                  n.delete(folderPath)
                  return n
                })
              })
          } else {
            setLoadingMap((lm) => {
              const n = new Map(lm)
              n.delete(folderPath)
              return n
            })
          }
        }
      }
      return next
    })
  }

  // 刷新工作区文件树
  const handleRefresh = () => {
    setChildrenMap(new Map())
    setExpandedDirs(new Set())
    setRefreshCount((c) => c + 1)
  }

  // 打开文件就地预览
  const openPreview = (file: DirectoryEntry) => {
    setPreviewingFile(file)
    setActiveTab('preview')
    setPreviewState({ loading: true, content: '', error: null, isImage: false, imageUrl: '' })

    if (window.copisBridge?.readFile) {
      window.copisBridge
        .readFile(file.path, sessionCwd)
        .then((res) => {
          if (!res) {
            setPreviewState({ loading: false, content: '', error: '无法读取文件', isImage: false, imageUrl: '' })
          } else if (!res.success) {
            setPreviewState({ loading: false, content: '', error: res.error || '读取失败', isImage: false, imageUrl: '' })
          } else if (res.isImage) {
            setPreviewState({ loading: false, content: '', error: null, isImage: true, imageUrl: res.content || '' })
          } else {
            setPreviewState({ loading: false, content: res.content || '', error: null, isImage: false, imageUrl: '' })
          }
        })
        .catch((err) => {
          setPreviewState({ loading: false, content: '', error: String(err?.message || err), isImage: false, imageUrl: '' })
        })
    } else {
      setPreviewState({ loading: false, content: '', error: '未连接到 Copis 文件服务', isImage: false, imageUrl: '' })
    }
  }

  // 在系统文件管理器中显示文件
  const handleLocateFile = (filePath: string) => {
    if (window.copisBridge?.showItemInFolder) {
      window.copisBridge.showItemInFolder(filePath, sessionCwd)
    }
  }

  // 复制代码内容
  const handleCopyContent = () => {
    if (!previewState.content) return
    navigator.clipboard.writeText(previewState.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  // 关闭面板
  const handleClose = () => {
    if (props.closeDetails) {
      props.closeDetails()
    } else {
      props.ctx.layout?.closeDetails()
    }
  }

  // 汇总所有已加载的文件列表（用于搜索过滤）
  const allLoadedFiles = useMemo(() => {
    const list: DirectoryEntry[] = []
    const scan = (items: DirectoryEntry[]) => {
      for (const item of items) {
        if (item.isDirectory) {
          const kids = childrenMap.get(item.path)
          if (kids) scan(kids)
        } else {
          list.push(item)
        }
      }
    }
    scan(rootEntries)
    return list
  }, [rootEntries, childrenMap])

  // 搜索匹配过滤
  const filteredFiles = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return []
    return allLoadedFiles.filter(
      (f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
    )
  }, [filterText, allLoadedFiles])

  // 递归渲染目录树
  const renderTreeNodes = (items: DirectoryEntry[], depth = 0): ReactElement[] => {
    return items.map((item) => {
      const isDir = item.isDirectory
      const isExpanded = isDir && expandedDirs.has(item.path)
      const isLoadingChild = isDir && loadingMap.get(item.path)
      const children = isDir ? childrenMap.get(item.path) || [] : []
      const isSelected = previewingFile?.path === item.path && activeTab === 'preview'

      return (
        <div key={item.path} style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            className="copis-tree-node-row"
            data-selected={isSelected ? 'true' : 'false'}
            style={{ paddingLeft: `${depth * 14 + 6}px` }}
            onClick={() => {
              if (isDir) {
                toggleFolder(item.path)
              } else {
                openPreview(item)
              }
            }}
            title={item.path}
          >
            {isDir ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', width: '12px' }}>
                {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            ) : (
              <span style={{ width: '12px', flexShrink: 0 }} />
            )}

            {isDir ? (
              isExpanded ? (
                <FolderOpen size={14} style={{ color: 'var(--creation-ui-primary, #6c00cc)' }} />
              ) : (
                <Folder size={14} style={{ color: 'var(--creation-ui-primary, #6c00cc)' }} />
              )
            ) : (
              <FileCode size={14} style={{ color: getFileIconColor(item.name) }} />
            )}

            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: isDir ? 500 : 400,
              }}
            >
              {item.name}
            </span>

            {!isDir && item.size !== undefined && (
              <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', flexShrink: 0 }}>
                {formatSize(item.size)}
              </span>
            )}
          </div>

          {isDir && isExpanded && (
            <div>
              {isLoadingChild ? (
                <div style={{ padding: '4px 0 4px 28px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
                  加载中...
                </div>
              ) : children.length > 0 ? (
                renderTreeNodes(children, depth + 1)
              ) : (
                <div style={{ padding: '4px 0 4px 28px', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
                  (空目录)
                </div>
              )}
            </div>
          )}
        </div>
      )
    })
  }

  return (
    <div className="copis-details-panel-root">
      {/* 顶部标签栏与关闭 */}
      <div className="copis-details-header-row">
        <div className="copis-details-tabs-group">
          <button
            type="button"
            className="copis-details-tab-button"
            data-active={activeTab === 'files' || activeTab === 'preview' ? 'true' : 'false'}
            onClick={() => setActiveTab('files')}
          >
            工作区
          </button>
          <button
            type="button"
            className="copis-details-tab-button"
            data-active={activeTab === 'tool' ? 'true' : 'false'}
            onClick={() => setActiveTab('tool')}
          >
            工具
          </button>
        </div>

        <button
          type="button"
          className="copis-details-close-btn"
          onClick={handleClose}
          aria-label="关闭详情面板"
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>

      {/* 内容区域 */}
      <div className="copis-details-content-body">
        {activeTab === 'tool' ? (
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {props.renderSlot ? (
              props.renderSlot('conversation.details.tool', {})
            ) : (
              <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '12px' }}>
                当前无活跃的工具调用信息
              </div>
            )}
          </div>
        ) : activeTab === 'preview' && previewingFile ? (
          <div className="copis-preview-container">
            {/* 预览导航栏 */}
            <div className="copis-preview-nav-bar">
              <button
                type="button"
                className="copis-preview-btn"
                onClick={() => setActiveTab('files')}
              >
                <ChevronLeft size={13} />
                <span>返回</span>
              </button>

              <span
                style={{
                  fontWeight: 600,
                  maxWidth: '180px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={previewingFile.path}
              >
                {previewingFile.name}
              </span>

              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {!previewState.isImage && previewState.content && (
                  <button
                    type="button"
                    className="copis-preview-btn"
                    onClick={handleCopyContent}
                    title="复制代码内容"
                  >
                    {copied ? <Check size={12} style={{ color: '#22c55e' }} /> : <Copy size={12} />}
                    <span>{copied ? '已复制' : '复制'}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="copis-preview-btn"
                  onClick={() => handleLocateFile(previewingFile.path)}
                  title="在系统文件管理器中显示"
                >
                  <ExternalLink size={12} />
                  <span>定位</span>
                </button>
              </div>
            </div>

            {/* 预览内容呈现 */}
            {previewState.loading ? (
              <div style={{ textAlign: 'center', padding: '60px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '12px' }}>
                正在读取文件内容...
              </div>
            ) : previewState.error ? (
              <div
                style={{
                  padding: '20px',
                  borderRadius: '8px',
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '0.5px solid rgba(239, 68, 68, 0.2)',
                  textAlign: 'center',
                  fontSize: '12px',
                }}
              >
                <div style={{ color: '#ef4444', fontWeight: 600, marginBottom: '6px' }}>预览失败</div>
                <div style={{ color: 'var(--dsw-alias-label-secondary, #71717a)', marginBottom: '12px' }}>
                  {previewState.error}
                </div>
                <button
                  type="button"
                  className="copis-header-action-btn"
                  onClick={() => openPreview(previewingFile)}
                >
                  重试
                </button>
              </div>
            ) : previewState.isImage ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, overflow: 'auto', padding: '10px' }}>
                <img
                  src={previewState.imageUrl}
                  alt={previewingFile.name}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: '6px' }}
                />
              </div>
            ) : (
              <div className="copis-code-view-wrapper">
                <code>{previewState.content || '// 空文件'}</code>
              </div>
            )}
          </div>
        ) : (
          /* 工作区文件树展示 */
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            {/* 搜索与刷新行 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
              <div className="copis-workspace-search-bar" style={{ flex: 1, marginBottom: 0 }}>
                <Search size={13} style={{ color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }} />
                <input
                  type="text"
                  className="copis-workspace-search-input"
                  placeholder="搜索文件..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
                {filterText && (
                  <button
                    type="button"
                    className="copis-workspace-refresh-btn"
                    onClick={() => setFilterText('')}
                    title="清空搜索"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <button
                type="button"
                className="copis-header-action-btn"
                style={{ height: '28px', padding: '0 8px' }}
                onClick={handleRefresh}
                title="刷新文件树"
              >
                <RefreshCw size={12} />
              </button>
            </div>

            {/* 根目录路径展示 */}
            {sessionCwd && (
              <div
                style={{
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-tertiary, #a1a1aa)',
                  marginBottom: '6px',
                  padding: '2px 4px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={sessionCwd}
              >
                根目录: <span style={{ color: 'var(--dsw-alias-label-secondary, #71717a)' }}>{sessionCwd.split(/[/\\]/).pop() || sessionCwd}</span>
              </div>
            )}

            {/* 树形列表内容 */}
            <div className="copis-tree-container">
              {filterText.trim() ? (
                filteredFiles.length > 0 ? (
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', padding: '4px 6px' }}>
                      匹配结果 ({filteredFiles.length})
                    </div>
                    {filteredFiles.map((file) => (
                      <div
                        key={file.path}
                        className="copis-tree-node-row"
                        onClick={() => openPreview(file)}
                        title={file.path}
                      >
                        <FileCode size={14} style={{ color: getFileIconColor(file.name) }} />
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {file.name}
                        </span>
                        {file.size !== undefined && (
                          <span style={{ fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
                            {formatSize(file.size)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '12px' }}>
                    未找到匹配的文件
                  </div>
                )
              ) : isRootLoading ? (
                <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '12px' }}>
                  正在加载工作区文件...
                </div>
              ) : rootEntries.length > 0 ? (
                renderTreeNodes(rootEntries, 0)
              ) : (
                <div style={{ textAlign: 'center', padding: '40px 10px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)', fontSize: '12px' }}>
                  <p>工作区为空</p>
                  <p style={{ fontSize: '11px', marginTop: '4px' }}>
                    {sessionCwd ? '当前目录未包含可展示的文件' : '等待会话初始化...'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
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
          background: 'var(--creation-ui-primary-background, rgba(108, 0, 204, 0.2))',
          color: 'var(--creation-ui-primary, #6c00cc)',
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

export function CopisShellOverlayManager(props: { ctx: CordisContext }): ReactElement {
  const [drawerOpen, setDrawerOpen] = useState(false)
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

      {/* 右侧全局工作区文件抽屉 */}
      {drawerOpen && (
        <>
          <div
            className="copis-details-drawer-backdrop"
            onClick={() => setDrawerOpen(false)}
            aria-label="关闭文件面板"
          />
          <div className="copis-details-drawer-root">
            <CopisDetailsPanel
              ctx={props.ctx}
              closeDetails={() => setDrawerOpen(false)}
            />
          </div>
        </>
      )}

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

export const inject = ['slots', 'layout', 'sessions']

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

  // 2. 中部对话区右上角操作项：切换回 Agent 模式与工作区文件展开
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
