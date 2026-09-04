/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠]
 *
 * MainArea 支持多标签页，Settings 视图为独立覆盖。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { CopisWorkingSidebar } from './CopisWorkingSidebar'
import { RightSidePanel } from './RightSidePanel'
import { MainArea } from '@/components/tabs/MainArea'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSidePanelWidthAtom, currentAgentSessionIdAtom, currentSessionSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { interfaceVariantAtom } from '@/atoms/theme'
import { CopisWorkingSettingsPanel } from './CopisWorkingSettingsPanel'
import { CopisWorkingPaymentModal } from './CopisWorkingPaymentModal'
import { SearchDialog } from './SearchDialog'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { workingAuthStateAtom, workingHistorySelectionAtom, workingSettingsOpenAtom, workingVipStatusAtom } from '@/atoms/working-atoms'
import { activeWebTabIdAtom } from '@/atoms/web-tabs'
import { WebBrowserSurface, WebTabBar } from '@/components/web-browser'
import { useStartCopisDiamondPurchase, useStartCopisVipUpgrade } from '@/hooks/useStartCopisDiamondPurchase'
import { workingPaymentStateAtom } from '@/atoms/working-payment-atoms'

const MIN_RIGHT_PANEL_WIDTH = 300
const MAX_RIGHT_PANEL_WIDTH = 560

function clampRightPanelWidth(width: number): number {
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, width))
}

export const MIN_LEFT_SIDEBAR_WIDTH = 200
export const MAX_LEFT_SIDEBAR_WIDTH = 400
export const DEFAULT_LEFT_SIDEBAR_WIDTH = 240

export function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const isPanelOpen = useAtomValue(currentSessionSidePanelOpenAtom)
  const automationForm = useAtomValue(automationFormAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const workingSettingsOpen = useAtomValue(workingSettingsOpenAtom)
  const workingAuth = useAtomValue(workingAuthStateAtom)
  const paymentOpen = useAtomValue(workingPaymentStateAtom).open
  const workingVipStatus = useAtomValue(workingVipStatusAtom)
  const setWorkingSettingsOpen = useSetAtom(workingSettingsOpenAtom)
  const setWorkingVipStatus = useSetAtom(workingVipStatusAtom)
  const startCopisDiamondPurchase = useStartCopisDiamondPurchase()
  const startCopisVipUpgrade = useStartCopisVipUpgrade()
  const isClassic = interfaceVariant === 'classic'
  // 定时任务表单打开时隐藏右侧文件面板，让中间区域扩展到全宽（表单内含自己的右栏配置）
  const activeView = useAtomValue(activeViewAtom)
  const workingHistorySelection = useAtomValue(workingHistorySelectionAtom)
  const showRightPanel = appMode === 'agent' && !!currentSessionId && !workingHistorySelection && !automationForm.open && activeView !== 'planning' && activeView !== 'automations' && activeView !== 'agent-skills' && activeView !== 'memory' && activeView !== 'expert-team' && activeView !== 'fund-stock'
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const activeWebTabId = useAtomValue(activeWebTabIdAtom)

  React.useEffect(() => {
    if (!paymentOpen || workingVipStatus) return
    void window.electronAPI.getWorkingSettingsSnapshot()
      .then((snapshot) => setWorkingVipStatus(snapshot.vip))
      .catch((error) => console.error('[Copis Working] 读取 VIP 支付配置失败:', error))
  }, [paymentOpen, setWorkingVipStatus, workingVipStatus])

  // 左侧边栏可拖拽宽度
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const leftDragging = React.useRef(false)
  const [isDraggingLeftSidebar, setIsDraggingLeftSidebar] = React.useState(false)
  const clampedLeftSidebarWidth = clampLeftSidebarWidth(leftSidebarWidth)

  React.useEffect(() => {
    // 若持久化存储为旧版的 300px 默认值，平滑自动收敛为更紧凑的 240px 默认值
    if (leftSidebarWidth === 300) {
      setLeftSidebarWidth(DEFAULT_LEFT_SIDEBAR_WIDTH)
      return
    }
    if (clampedLeftSidebarWidth !== leftSidebarWidth) {
      setLeftSidebarWidth(clampedLeftSidebarWidth)
    }
  }, [clampedLeftSidebarWidth, leftSidebarWidth, setLeftSidebarWidth])

  const handleLeftSidebarMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    leftDragging.current = true
    setIsDraggingLeftSidebar(true)
    const startX = e.clientX
    const startWidth = clampedLeftSidebarWidth
    // 记录最新光标位置，rAF 回调读取它而非调度时捕获的旧事件，避免快拖时坐标滞后
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = latestClientX - startX
      setLeftSidebarWidth(clampLeftSidebarWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      leftDragging.current = false
      setIsDraggingLeftSidebar(false)
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      // 补一次最终 flush，保证落点停在光标实际位置而非上一帧
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedLeftSidebarWidth, setLeftSidebarWidth])

  // 右侧面板可拖拽宽度
  const [rightPanelWidth, setRightPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const dragging = React.useRef(false)
  const clampedRightPanelWidth = clampRightPanelWidth(rightPanelWidth)

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    // 记录最新光标位置，rAF 回调读取它而非调度时捕获的旧事件，避免快拖时坐标滞后
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = startX - latestClientX
      setRightPanelWidth(clampRightPanelWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      dragging.current = false
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      // 补一次最终 flush，保证落点停在光标实际位置而非上一帧
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedRightPanelWidth, setRightPanelWidth])

  return (
    <AppShellProvider value={contextValue}>
      {/* 可拖动标题栏区域，用于窗口拖动。
          Windows 上必须避开右上角的 WindowControls 区域（buttons ~118px + 8px buffer = 126px），
          否则 drag-region 与按钮区的 hitmask 重叠会让 OS 把单击当成标题栏点击，
          表现为"按钮要双击才响应"。 */}
      <div
        className={cn(
          'titlebar-drag-region fixed top-0 left-0 h-[50px] z-50',
          isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0'
        )}
      />

      {/* Windows 自定义窗口控制按钮（最小化/最大化/关闭） */}
      <SearchDialog />

      <div className="shell-bg relative flex h-screen w-screen flex-col overflow-hidden bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900">
        <WebTabBar />
        <div className="relative min-h-0 flex-1">
          <div
            className={cn(
              'absolute inset-0 flex h-full w-full',
              (workingSettingsOpen || activeWebTabId) && 'invisible pointer-events-none',
            )}
            aria-hidden={workingSettingsOpen || !!activeWebTabId}
          >
            {/* 左侧边栏：可折叠，可拖拽调整宽度 */}
            <div className={cn(isClassic ? 'p-2 pr-0' : '', 'relative z-[60] crt-sidebar')}>
              <CopisWorkingSidebar width={clampedLeftSidebarWidth} noTransition={isDraggingLeftSidebar} />
              {/* 侧边栏展开时显示拖拽手柄，折叠态隐藏 */}
              {!sidebarCollapsed && (
                <div
                  className={cn(
                    'absolute right-0 top-0 bottom-0 w-4 translate-x-1/2 cursor-col-resize hover:bg-primary/5 active:bg-primary/50 transition-colors z-20'
                  )}
                  onMouseDown={handleLeftSidebarMouseDown}
                />
              )}
            </div>
            {!isClassic && (
              <div aria-hidden="true" className="relative z-[61] w-px flex-shrink-0 bg-border/80 dark:bg-border/70" />
            )}

            {/* 中间容器：relative z-[60] 使其在 z-50 拖动区域之上 */}
            <div className={cn('flex-1 min-w-0 relative z-[60]', isClassic && 'p-2')}>
              {/* 主内容区域（TabBar + TabContent） */}
              <MainArea />
            </div>

            {/* 右侧边栏：Agent 文件面板 */}
            {showRightPanel && (
              <div
                className={cn(
                  'relative z-[60] flex items-stretch crt-sidebar',
                  isClassic
                    ? 'transition-[padding] duration-300 ease-in-out'
                    : '',
                  isClassic && (isPanelOpen ? 'p-2 pl-0' : 'p-0')
                )}
              >
                {!isClassic && (
                  <div aria-hidden="true" className="pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-px bg-border/80 dark:bg-border/70" />
                )}
                {/* 拖拽手柄 */}
                {isPanelOpen && (
                  <div
                    className={cn(
                      'absolute left-0 top-0 bottom-0 w-[8px] -translate-x-1/2 cursor-col-resize active:bg-primary/50 transition-colors',
                      isClassic ? 'z-10' : 'z-20'
                    )}
                    onMouseDown={handleMouseDown}
                  />
                )}
                <RightSidePanel width={clampedRightPanelWidth} />
              </div>
            )}
          </div>
          {activeWebTabId && <WebBrowserSurface />}
          {workingSettingsOpen && (
            <div
              className={cn(
                'absolute inset-0 z-[60]',
                activeWebTabId && 'invisible pointer-events-none',
              )}
              aria-hidden={!!activeWebTabId}
            >
              <CopisWorkingSettingsPanel onClose={() => setWorkingSettingsOpen(false)} />
            </div>
          )}
          <CopisWorkingPaymentModal
            vipStatus={workingVipStatus ?? (workingAuth?.user ? {
              isVip: workingAuth.user.isVip === true,
              vipExpiresAt: workingAuth.user.vipExpiresAt ?? null,
              tokens: workingAuth.user.tokens ?? 0,
              diamonds: workingAuth.user.tokens ?? 0,
              upgradeDays: 30,
              quotaBytes: 0,
              quotaLabel: '',
            } : null)}
            onStartDiamondPurchase={startCopisDiamondPurchase}
            onStartVipUpgrade={startCopisVipUpgrade}
          />
        </div>
      </div>
    </AppShellProvider>
  )
}
