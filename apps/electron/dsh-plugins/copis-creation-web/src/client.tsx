import { DEFAULT_DSH_PINNED_MENU_IDS, isDshExpandedSidebarWidth } from '@copis/shared/types/dsh'
import {
  BookOpen,
  Brain,
  CalendarClock,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Puzzle,
  Search,
  Settings,
  Timer,
  TrendingUp,
  UsersRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import { SharedRoomSection } from './SharedRoomSection'
import { registerMediaPreview, type MediaPreviewContext, type MediaPreviewBridge } from './MediaPreview'
import { registerSessionCompletion, type CompletionContext, type CompletionBridge } from './session-completion'

interface LayoutController {
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

interface CordisContext extends MediaPreviewContext {
  uiWorkspace: { startSession(): void; openSession(id: string): void }
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
    copisBridge?: CompletionBridge & {
      navigate?: (view: string, tab?: string) => void
      openSearch?: () => void
      openSettings?: () => void
      getPinnedMenuItems?: () => Promise<string[]>
      setPinnedMenuItems?: (ids: string[]) => Promise<void>
      listDirectory?: (dirPath?: string, cwd?: string) => Promise<DirectoryEntry[]>
      getActiveWorkspacePath?: (cwd?: string) => Promise<string>
      readFile?: (filePath: string, cwd?: string) => Promise<ReadFileResult>
      prepareMediaPreview?: MediaPreviewBridge['prepareMediaPreview']
      releaseMediaPreview?: MediaPreviewBridge['releaseMediaPreview']
      showItemInFolder?: (filePath: string, cwd?: string) => Promise<{ success: boolean; error?: string }>
    }
  }
}

const CREATION_STYLES_ID = 'copis-creation-web-styles'

// DSH 以普通 script 加载插件，使用 Jotai 的 CommonJS 入口以避免引入 import.meta。
const { atom, useAtom } = require('jotai') as typeof import('jotai')
const menuExpandedAtom = atom(false)
const pinnedMenuIdsAtom = atom<readonly string[]>(DEFAULT_DSH_PINNED_MENU_IDS)

const WORKSPACE_GROUP_CHAT: SidebarMenuItem = { id: 'group-chat', label: '群聊协作', icon: UsersRound, view: 'group-chat' }

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

  /* 隐藏 DSH 原生侧栏中遗留的旧版静态菜单（无 data-copis-placement），只保留 copis-creation-web 插件动态挂载的导航菜单 */
  .copis-menu-section:not([data-copis-placement="before-workspaces"]),
  .copis-rail-menu-section:not([data-copis-placement="before-workspaces"]) {
    display: none !important;
  }

  .copis-room-section { width: 100%; min-width: 0; margin: 8px 0; }
  .copis-room-heading { display:flex; align-items:center; gap:2px; }
  .copis-room-toggle { flex:1; flex-flow:row nowrap; min-width:0; font-weight:600; }
  .copis-room-action { anchor-name:var(--copis-room-anchor); display:grid; place-items:center; width:26px; height:26px; border:0; border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary,currentColor); cursor:pointer; }
  .copis-room-action:disabled { opacity:.5; cursor:default; }
  .copis-room-action svg { width:15px; height:15px; }
  .copis-room-action-menu {
    position:fixed; position-anchor:var(--copis-room-anchor); inset:auto; top:anchor(bottom); right:anchor(right);
    position-try-fallbacks:flip-block; margin:5px 0; width:158px; padding:4px; box-sizing:border-box;
    color:var(--dsw-alias-label-primary,#242832);
    border:1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius:9px; box-shadow:0 6px 18px #0002;
  }
  body[data-ds-dark-theme] .copis-room-action-menu { color:var(--dsw-alias-label-primary,#e6eaf0); }
  .copis-room-action-menu button { display:flex; align-items:center; gap:10px; width:100%; padding:9px 10px; border:0; border-radius:6px; background:transparent; color:inherit; font:inherit; font-size:13px; cursor:pointer; }
  .copis-room-action-menu button:is(:hover,:focus-visible) { color:var(--creation-ui-primary); background:var(--creation-ui-primary-background); }
  .copis-room-action-menu svg { width:15px; height:15px; }
  .copis-room-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
  .copis-menu-item > .copis-room-unread-slot { display:flex; flex:0 0 8px; width:8px; height:8px; align-items:center; justify-content:center; }
  .copis-room-unread-dot { display:block; flex:0 0 7px; width:7px; height:7px; border-radius:50%; background:#ef4444; }
  .copis-workspace-group-entry { position:relative; }
  .copis-workspace-group-entry > .copis-room-unread-dot { position:absolute; top:3px; right:3px; }
  .copis-room-children { margin-block-start:6px; padding-inline-start:16px; min-width:0; }
  .copis-room-row { display:grid; grid-template-columns:minmax(0,1fr) 26px; align-items:center; border-radius:7px; }
  .copis-room-row > .copis-menu-item span { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .copis-room-more { opacity:0; pointer-events:none; }
  .copis-room-row:is(:hover,:focus-within) .copis-room-more, .copis-room-more[aria-expanded="true"] { opacity:1; pointer-events:auto; }
  @media (hover:none) { .copis-room-more { opacity:1; pointer-events:auto; } }
  .copis-room-children small { display:block; padding:4px 8px; color:var(--dsw-alias-label-secondary,currentColor); }
  .copis-workspace-group-entry { margin: 8px 0; }
  .copis-workspace-group-entry.copis-rail-menu-item { margin-inline: auto; }

  .copis-menu-section {
    box-sizing: border-box;
    display: grid;
    flex: none;
    gap: 0;
    width: 100%;
    margin: 0 0 8px;
    padding: 0 2px;
  }

  .copis-menu-heading,
  .copis-menu-item {
    font-size: 14px;
  }

  .copis-menu-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 3px;
    color: var(--dsw-alias-label-secondary, #71717a);
    font-weight: 600;
  }

  .copis-menu-section > .copis-menu-row,
  .copis-menu-section > .copis-menu-toggle {
    margin-inline-start: 16px;
    width: calc(100% - 16px);
  }

  .copis-menu-section .copis-menu-toggle {
    min-height: 26px;
    color: var(--dsw-alias-label-secondary, #71717a);
    font-size: 12px;
  }

  .copis-settings-entry { margin-top: 5px; }

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
    font-weight: 400;
    line-height: 1.25;
    text-align: left;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
    user-select: none;
  }

  .copis-menu-row:hover > .copis-menu-item,
  .copis-menu-row:focus-within > .copis-menu-item,
  .copis-menu-item:hover:where(:not(.copis-room-toggle)),
  .copis-menu-item:focus-visible,
  .copis-menu-item[data-active="true"],
  .copis-rail-menu-item:hover:where(:not(.copis-workspace-group-entry)),
  .copis-rail-menu-item:focus-visible,
  .copis-rail-menu-item[data-active="true"] {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15));
    color: var(--creation-ui-primary, #6c00cc);
  }

  .copis-menu-item[data-active="true"] {
    font-weight: 600;
  }

  /* 群行只在父容器绘制一次底色，群名与更多按钮仍是两个独立点击区。 */
  .copis-room-heading .copis-room-toggle:focus-visible,
  .copis-room-heading .copis-room-action:enabled:is(:hover,:focus-visible,[aria-expanded="true"]),
  .copis-rail-menu-item.copis-workspace-group-entry:is(:focus-visible,[data-active="true"]),
  .copis-room-row:is(:hover,:focus-within,:has(.copis-room-more[aria-expanded="true"])) {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1));
    color: var(--dsw-alias-label-primary, currentColor);
  }
  .copis-room-row > .copis-menu-item {
    background: transparent;
    color: var(--dsw-alias-label-primary, inherit);
  }
  .copis-room-row > .copis-menu-item[data-active="true"] { font-weight:500; }

  .copis-menu-heading svg,
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

  .copis-menu-row {
    position: relative;
    min-width: 0;
  }

  .copis-menu-pin-btn {
    position: absolute;
    inset-inline-end: 8px;
    top: 50%;
    transform: translateY(-50%);
    height: 20px;
    padding: 0 7px;
    border: 1px solid currentColor;
    border-radius: 9999px;
    background: transparent;
    color: var(--creation-ui-primary, #6c00cc);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
  }

  .copis-menu-row:is(:hover, :focus-within) > .copis-menu-pin-btn {
    opacity: 1;
    pointer-events: auto;
  }

  .copis-menu-row:is(:hover, :focus-within) > .copis-menu-item {
    padding-inline-end: 76px !important;
  }

  .copis-menu-pin-btn:is(:hover, :focus-visible) {
    background: var(--creation-ui-primary-background, rgba(108, 0, 204, 0.15));
  }

  .copis-menu-pin-btn:disabled {
    cursor: default;
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
  .copis-room-row:has(> .copis-menu-item[data-active="true"]),
  .YDXeBa_sessionRow.YDXeBa_selected,
  .YDXeBa_searchResultRow.YDXeBa_selected,
  .YDXeBa_projectRow.active,
  [class*="sessionRow"][class*="selected"],
  [class*="searchResultRow"][class*="selected"],
  [class*="projectRow"][class*="active"],
  [class*="sessionRow"][data-selected="true"],
  [class*="SessionRow"][data-selected="true"] {
    background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1)) !important;
    color: var(--dsw-alias-label-primary, #ffffff) !important;
    font-weight: 500 !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected *,
  [class*="sessionRow"][class*="selected"] * {
    color: var(--dsw-alias-label-primary, #ffffff) !important;
  }
  .YDXeBa_sessionRow.YDXeBa_selected [class*="date"],
  .YDXeBa_sessionRow.YDXeBa_selected [class*="time"],
  [class*="sessionRow"][class*="selected"] [class*="date"],
  [class*="sessionRow"][class*="selected"] [class*="time"],
  [class*="sessionRow"][class*="selected"] span:last-child {
    color: #a1a1aa !important;
  }
  .copis-room-row > .copis-menu-item[data-active="true"] svg,
  [class*="sessionRow"][class*="selected"] svg,
  [class*="searchResultRow"][class*="selected"] svg,
  [class*="projectRow"][class*="active"] svg {
    color: var(--dsw-alias-label-secondary, #d4d4d8) !important;
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

  /* RC2 侧栏根节点为 div，覆盖原生抽屉保留的 48px 宽度差。 */
  body.copis-subview-active :is(.copis-creation-sidebar, .hHd-Xa_root, [class*="SidebarRoot_root"]) {
    box-sizing: border-box;
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

  /* 只在文字节点生成标签，避免 RC2 的 LabelMask 再生成一次。 */
  body.copis-subview-active [class*="newSessionLabel"]:not([class*="newSessionLabelMask"])::after {
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

  /* 隐藏顶部右上角原生的 session-log-download 及任何 Agent 模式切换按钮 */
  button[class*="sessionLogButton"],
  button[title*="返回 Agent 模式"],
  button[title*="返回Agent 模式"],
  button[aria-label*="返回 Agent 模式"],
  button[aria-label*="返回Agent 模式"],
  [data-slot-id="session-log-download"] {
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

  .copis-room-action-menu,
  .copis-search-modal-card {
    background: var(--dsw-alias-bg-base, #ffffff);
  }

  .copis-search-modal-card {
    width: 580px;
    max-width: calc(100vw - 32px);
    max-height: 520px;
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
`

function installCreationStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(CREATION_STYLES_ID)) return

  const style = document.createElement('style')
  style.id = CREATION_STYLES_ID
  style.textContent = CREATION_UI_CSS
  document.head.appendChild(style)
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

// 读取目录不等于导航：不能激活子视图或改变左栏宽度。
function requestRoomDirectory(tab: 'refresh' | 'sidebar-sync' | `manage:${string}`) {
  if (window.copisBridge?.navigate) window.copisBridge.navigate('group-chat', tab)
  else window.postMessage({ type: 'COPIS_NAVIGATE', view: 'group-chat', tab }, '*')
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

function attachSidebarMenu(element: HTMLElement) {
  const sidebar = (element.closest('[class*="_root"]') ??
    element.closest('[class*="SidebarRoot"]') ??
    element.closest('[class*="_sidebarCol"], [class*="sidebarCol"]') ??
    element.closest('aside')) as HTMLElement | null
  if (!sidebar) return null

  sidebar.classList.add('copis-creation-sidebar')

  // 清理原生侧栏中可能遗留的旧版硬编码菜单节点（无 data-copis-placement），避免与独立插件菜单重复
  const legacySections = sidebar.querySelectorAll(
    '.copis-menu-section:not([data-copis-placement="before-workspaces"]), .copis-rail-menu-section:not([data-copis-placement="before-workspaces"])',
  )
  legacySections.forEach((el) => el.remove())

  const target =
    sidebar.querySelector('[class*="_regionArea"], [class*="regionArea"]') ??
    sidebar.querySelector('button[class*="_newSession"], button[class*="newSession"]')

  if (!target?.parentElement) return null
  // RC2 的工作区在滚动容器内；Portal 不挪动 Cordis slot 持有的 React 节点。
  const host = document.createElement('div')
  host.style.display = 'contents'
  // RC2 滚动区的首尾列仅用于留白；菜单必须放在中间内容列内部，而非作为网格的自动布局项。
  if (target.parentElement.matches('[class*="_scrollArea"]') && target.matches('[class*="regionArea"]')) {
    target.prepend(host)
  } else {
    target.before(host)
  }
  const afterWorkspaces = document.createElement('div')
  afterWorkspaces.dataset.copisPlacement = 'after-workspaces'
  if (target.parentElement.matches('[class*="_scrollArea"]')) {
    // 不参与 RC2 的网格自动选列，否则按钮会被放进 4px 留白列。
    afterWorkspaces.style.gridArea = '-1 / 2' // 显式行末尾，避免自动布局回填到顶部空行。
  }
  target.after(afterWorkspaces)
  return { before: host, after: afterWorkspaces }
}

let cachedCordisContext: CordisContext | null = null

export function CreationSidebarNavigation(props: {
  collapsed?: boolean
  width?: number
  wide?: boolean
  ctx?: CordisContext
}): ReactElement {
  const [activeView, setActiveView] = useState<CreationView>('conversations')
  const [expanded, setExpanded] = useAtom(menuExpandedAtom)
  const [pinnedMenuIds, setPinnedMenuIds] = useAtom(pinnedMenuIdsAtom)
  const [pinsReady, setPinsReady] = useState(false)
  const [savingPins, setSavingPins] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const [menuHost, setMenuHost] = useState<ReturnType<typeof attachSidebarMenu>>(null)
  const isSubviewActive = activeView !== 'conversations'
  const effectiveCtx = props.ctx ?? cachedCordisContext

  // 在子视图激活（记忆/知识库/日程表等）时，强制判定 wide 展开态，绝不渲染窄 rail
  const wide =
    isSubviewActive ||
    Boolean(props.wide) ||
    (!props.collapsed && (props.width === undefined || props.width >= 200))

  useLayoutEffect(() => {
    const host = rootRef.current && attachSidebarMenu(rootRef.current)
    setMenuHost(host)
    return () => { host?.before.remove(); host?.after.remove() }
  }, [props.collapsed, props.wide])

  useLayoutEffect(() => {
    if (isSubviewActive || !wide) return
    const anchor = rootRef.current
    const sidebar = anchor?.closest('[class*="_sidebarCol"]') ?? anchor?.closest('.copis-creation-sidebar')
    if (!sidebar) return

    let lastWidth = 0
    const reportWidth = () => {
      // 只记住进入功能页前的真实宽度，不把功能页裁切或原生抽屉的宽度当成新偏好。
      if (document.body.classList.contains('copis-subview-active') || sidebar.closest('[data-sidebar-drawer], [data-sidebar-collapsed]')) return
      const width = Math.round(sidebar.getBoundingClientRect().width)
      if (width === lastWidth || !isDshExpandedSidebarWidth(width)) return
      lastWidth = width
      window.copisBridge?.reportSidebarInfo?.({ width, wide: true })
    }
    const observer = typeof window.ResizeObserver !== 'undefined' ? new window.ResizeObserver(reportWidth) : null
    observer?.observe(sidebar)
    reportWidth()
    return () => observer?.disconnect()
  }, [isSubviewActive, wide, props.width])

  // RC2 进入抽屉布局时，即使原生栏已折叠且不可交互，footer slot 仍会报告 wide=true。
  // 以当前 AppFrame 的实际折叠状态为准，通过 DSH 布局服务展开，不修改原生 DOM 状态。
  useEffect(() => {
    const layout = effectiveCtx?.layout
    if (!isSubviewActive || !layout) return

    const anchor = rootRef.current
    const frame = anchor?.closest('[class*="_frame"], [data-sidebar-drawer]')
    let requested = false
    const expandIfCollapsed = () => {
      const collapsed = frame
        ? frame.hasAttribute('data-sidebar-collapsed')
        : props.collapsed === true || Boolean(anchor?.closest('.hHd-Xa_collapsed'))
      if (!collapsed) {
        requested = false
        return
      }
      if (requested) return
      requested = true
      layout.toggleSidebar()
    }

    // 宿主缩窄发生在 Copis 功能激活之后，监听布局变化才能捕捉后到的折叠状态。
    const observer = frame && typeof window.MutationObserver !== 'undefined'
      ? new window.MutationObserver(expandIfCollapsed)
      : null
    if (frame) observer?.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    expandIfCollapsed()
    return () => observer?.disconnect()
  }, [isSubviewActive, props.collapsed, effectiveCtx])

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
    const bridge = window.copisBridge
    if (!bridge?.getPinnedMenuItems) return
    let active = true
    void bridge.getPinnedMenuItems().then((ids) => {
      if (!active) return
      setPinnedMenuIds(Array.isArray(ids) ? ids : DEFAULT_DSH_PINNED_MENU_IDS)
      setPinsReady(true)
    }).catch((err) => console.warn('[Copis 功能] 读取固定菜单失败:', err))
    return () => { active = false }
  }, [setPinnedMenuIds])

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

  const togglePin = async (menuId: string) => {
    const bridge = window.copisBridge
    if (!pinsReady || savingPins || !bridge?.setPinnedMenuItems) return
    const next = SIDEBAR_MENU_ITEMS.filter(({ id }) => id === menuId
      ? !pinnedMenuIds.includes(id)
      : pinnedMenuIds.includes(id)).map(({ id }) => id)
    setSavingPins(true)
    setPinnedMenuIds(next)
    try {
      await bridge.setPinnedMenuItems(next)
    } catch (err) {
      setPinnedMenuIds(pinnedMenuIds)
      console.warn('[Copis 功能] 保存固定菜单失败:', err)
    } finally {
      setSavingPins(false)
    }
  }

  const pinned = SIDEBAR_MENU_ITEMS.filter(({ id }) => pinnedMenuIds.includes(id))
  const unpinned = SIDEBAR_MENU_ITEMS.filter(({ id }) => !pinnedMenuIds.includes(id))
  const itemClass = wide ? 'copis-menu-item' : 'copis-rail-menu-item'
  const ToggleIcon = expanded ? ChevronUp : ChevronDown
  const toggleLabel = expanded ? '收起' : '展开显示'

  const renderMenuItem = (item: SidebarMenuItem, isPinned: boolean) => {
    const Icon = item.icon
    const action = isPinned ? '取消固定' : '固定显示'
    const button = (
      <button key={item.id} type="button" className={itemClass} data-copis-menu-id={item.id}
        data-active={item.view === activeView ? 'true' : 'false'} aria-label={item.label} title={wide ? undefined : item.label}
        onClick={() => selectItem(item)}>
        <Icon size={wide ? 16 : 18} strokeWidth={1.8} aria-hidden="true" />
        {wide && <span>{item.label}</span>}
        {wide && item.badge && <span className={`copis-menu-badge ${item.badge === 'BETA' ? 'copis-menu-badge-beta' : 'copis-menu-badge-flexible'}`}>{item.badge}</span>}
      </button>
    )
    return wide ? (
      <div key={item.id} className="copis-menu-row">
        {button}
        <button type="button" className="copis-menu-pin-btn" aria-label={`${action}${item.label}`} title={action}
          disabled={!pinsReady || savingPins} onClick={() => void togglePin(item.id)}>{action}</button>
      </div>
    ) : button
  }

  const menu = (
    <div className={wide ? 'copis-menu-section' : 'copis-rail-menu-section'} data-copis-placement="before-workspaces" role="group" aria-label="Copis功能">
      {wide && (
        <div className="copis-menu-heading">
          <LayoutGrid size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>Copis功能</span>
        </div>
      )}
      {pinned.map((item) => renderMenuItem(item, true))}
      {unpinned.length > 0 && (
        <button type="button" className={`${itemClass} copis-menu-toggle`} aria-expanded={expanded} aria-label={toggleLabel}
          title={wide ? undefined : toggleLabel} onClick={() => setExpanded(!expanded)}>
          <ToggleIcon size={14} />{wide && <span>{toggleLabel}</span>}
        </button>
      )}
      {expanded && unpinned.map((item) => renderMenuItem(item, false))}
      <button type="button" className={`${itemClass} copis-settings-entry`} aria-label="Copis 设置" title={wide ? undefined : 'Copis 设置'}
        onClick={() => sendNavigation('settings')}>
        <Settings size={wide ? 16 : 18} strokeWidth={1.8} />{wide && <span>Copis 设置</span>}
      </button>
    </div>
  )
  const groupEntry = <SharedRoomSection wide={wide} active={activeView==='group-chat'} directory={requestRoomDirectory}
    open={tab=>selectItem({...WORKSPACE_GROUP_CHAT,tab})}/>
  return <><span ref={rootRef} hidden />{menuHost ? createPortal(menu, menuHost.before) : menu}
    {menuHost ? createPortal(groupEntry, menuHost.after) : groupEntry}</>
}

interface CopisSearchItem {
  id: string
  title: string
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
  const [hasSearched, setHasSearched] = useState(false)
  const [titleResults, setTitleResults] = useState<CopisSearchItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)

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
      setHasSearched(false)
      setSelectedIndex(0)
    }
  }, [props.open])

  // 执行搜索
  const runSearch = useCallback(() => {
    const q = query.trim()
    if (!q) {
      setTitleResults([])
      setHasSearched(false)
      setCommittedQuery('')
      return
    }

    setCommittedQuery(q)
    setHasSearched(true)
    setSelectedIndex(0)

    const qLower = q.toLowerCase()
    const titles: CopisSearchItem[] = []

    // 仅检索可在 DSH 中打开的会话标题。
    try {
      const listSnapshot = props.ctx.sessions?.list?.getSnapshot()
      if (listSnapshot?.byId) {
        for (const [id, s] of Object.entries(listSnapshot.byId as Record<string, any>)) {
          const t = s?.title || '新会话'
          if (t.toLowerCase().includes(qLower)) {
            titles.push({
              id,
              title: t,
              updatedAt: s?.updatedAt || s?.createdAt || 0,
            })
          }
        }
      }
    } catch (err) {
      console.warn('[CopisSearchModal] 读取 DSH 会话失败:', err)
    }

    titles.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    setTitleResults(titles)
  }, [query, props.ctx.sessions])

  const navigateToResult = useCallback((item: CopisSearchItem) => {
    props.onClose()
    props.ctx.uiWorkspace.openSession(item.id)
  }, [props.ctx.uiWorkspace, props.onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (titleResults.length > 0 ? (prev + 1) % titleResults.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (titleResults.length > 0 ? (prev - 1 + titleResults.length) % titleResults.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (isComposingRef.current) return
      if (query.trim() !== committedQuery || !hasSearched) {
        runSearch()
      } else if (titleResults[selectedIndex]) {
        navigateToResult(titleResults[selectedIndex])
      }
    }
  }, [titleResults, committedQuery, hasSearched, navigateToResult, props, query, runSearch, selectedIndex])

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
            disabled={!query.trim()}
            onClick={() => runSearch()}
          >
            <Search size={13} />
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

          {hasSearched && titleResults.length === 0 && (
            <div style={{ padding: '36px 16px', textAlign: 'center', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, #a1a1aa)' }}>
              未找到与 "{committedQuery}" 匹配的会话标题
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
                  <span className="copis-search-badge-creation">创造</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '13px', fontWeight: 500 }}>
                    <HighlightSearchText text={item.title} query={committedQuery} />
                  </span>
                </button>
              ))}
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

/** 全局根层仅托管搜索；详情侧栏交由 DSH 官方组件管理。 */
export function CopisShellOverlayManager(props: { ctx: CordisContext }): ReactElement | null {
  const [searchOpen, setSearchOpen] = useState(false)

  // 监听搜索浮层唤起事件与 Cmd+K / Ctrl+K 快捷键
  useEffect(() => {
    const handleOpenSearch = () => setSearchOpen(true)
    const handleMessage = (event: MessageEvent) => {
      if (event.source && event.source !== window) return
      const type = event.data?.type
      if (type === 'COPIS_DSH_NEW_SESSION') {
        const id = event.data.requestId
        if (typeof id !== 'string' || !id || id.length > 128) return
        // 宿主串行派发；同一原生网页重载后也只需记住最后一条已接收的命令。
        const key = 'copis.dsh.lastNewSessionRequest'
        if (window.sessionStorage.getItem(key) !== id) {
          setSearchOpen(false)
          props.ctx.uiWorkspace.startSession()
          window.sessionStorage.setItem(key, id)
        }
        window.copisBridge?.navigate?.('conversations', `dsh-session-accepted:${id}`)
      } else if (type === 'COPIS_OPEN_SEARCH_MODAL' || type === 'COPIS_OPEN_SEARCH') {
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
    window.copisBridge?.navigate?.('conversations', 'dsh-client-ready')

    return () => {
      window.removeEventListener('COPIS_OPEN_SEARCH_MODAL', handleOpenSearch)
      window.removeEventListener('message', handleMessage)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [props.ctx.uiWorkspace])

  return searchOpen ? (
    <CopisSearchModal open onClose={() => setSearchOpen(false)} ctx={props.ctx} />
  ) : null
}

export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'documentPreviews', 'remote.session', 'sidebarRight', 'uiWorkspace']

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

  // 2. 全局搜索浮层，保留官方详情区及其右上角控制按钮。
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

  registerMediaPreview(ctx, () => window.copisBridge)
  registerSessionCompletion(ctx as unknown as CompletionContext, () => window.copisBridge)

  console.log('[Copis Creation Web] 客户端插件插槽注入完成')
}
