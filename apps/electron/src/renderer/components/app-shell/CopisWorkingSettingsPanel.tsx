import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  ArrowLeft,
  Clipboard,
  CircleCheck,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Crown,
  Gem,
  GraduationCap,
  HardDrive,
  HardDriveDownload,
  Info,
  LogOut,
  MessageSquare,
  Mic,
  Palette,
  RefreshCw,
  Sparkles,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type {
  WorkingLedgerEntry,
  WorkingReceiveChannelSettings,
  WorkingSettingsSnapshot,
  WorkingUser,
} from '@copis/shared'
import {
  workingAuthStateAtom,
  workingSettingsSectionAtom,
  workingVipStatusAtom,
  type WorkingSettingsSectionId,
} from '@/atoms/working-atoms'
import {
  closeWorkingPaymentAtom,
  openWorkingPaymentAtom,
  requestWorkingPaymentRefreshAtom,
  workingPaymentNoticeAtom,
  workingPaymentRefreshAtom,
} from '@/atoms/working-payment-atoms'
import { activeTabIdAtom, openTab, tabsAtom, TUTORIAL_TAB_ID, TUTORIAL_TAB_TITLE } from '@/atoms/tab-atoms'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { hasUpdateAtom } from '@/atoms/updater'
import { AboutUpdatesSettings } from '@/components/settings/AboutUpdatesSettings'
import { AppearanceSettings } from '@/components/settings/AppearanceSettings'
import { MigrationSettings } from '@/components/settings/MigrationSettings'
import { StorageSettings } from '@/components/settings/StorageSettings'
import { VoiceInputSettings } from '@/components/settings/VoiceInputSettings'
import { ModelManagementSettings } from '@/components/settings/ModelManagementSettings'
import {
  formatWorkingDiscount,
  formatWorkingLedgerDescription,
  isWorkingModelDeduction,
  paginateWorkingLedgerEntries,
  selectWorkingConsumptionLedgerEntries,
} from '@/lib/working-ledger'
import { CopisWorkingMessageSettingsPanel } from './CopisWorkingMessageSettingsPanel'
import { CopisWorkingOrdersPanel } from './CopisWorkingOrdersPanel'
import './CopisWorkingSettingsPanel.css'

type WorkingSettingsMenuId = WorkingSettingsSectionId | 'tutorial'

interface WorkingSettingsMenuItem {
  id: WorkingSettingsMenuId
  label: string
  description: string
  icon: LucideIcon
}

export const WORKING_SETTINGS_MENU: readonly WorkingSettingsMenuItem[] = [
  {
    id: 'settings',
    label: '账户设置',
    description: '查看账户余额、VIP 权益、邀请信息和钻石流水。',
    icon: UserRound,
  },
  {
    id: 'model-management',
    label: '模型管理',
    description: '配置 VIP 专属的私有大模型与 API 密钥。',
    icon: SlidersHorizontal,
  },
  {
    id: 'messages',
    label: 'App 连接器',
    description: '选择 Copis 工作消息的接收渠道并查看绑定状态。',
    icon: MessageSquare,
  },
  {
    id: 'orders',
    label: '我的订单',
    description: '查看钻石充值和 VIP 升级订单。',
    icon: ClipboardList,
  },
  {
    id: 'tutorial',
    label: '查看使用教程',
    description: '打开 Copis 使用教程。',
    icon: GraduationCap,
  },
  {
    id: 'voice-input',
    label: '语音输入',
    description: '管理麦克风权限、语音服务和全局语音输入行为。',
    icon: Mic,
  },
  {
    id: 'migration',
    label: '数据迁移',
    description: '导入或导出 Copis 工作区、Skills 和 MCP 配置。',
    icon: HardDriveDownload,
  },
  {
    id: 'storage',
    label: '磁盘管理',
    description: '查看本地占用并清理临时文件和历史数据。',
    icon: HardDrive,
  },
  {
    id: 'appearance',
    label: '外观设置',
    description: '调整主题、界面风格、字体、预览和应用图标。',
    icon: Palette,
  },
  {
    id: 'about',
    label: '关于/更新',
    description: '查看主程序与本地模块版本，并检查、下载和安装更新。',
    icon: Info,
  },
] as const

interface CopisWorkingSettingsPanelProps {
  onClose: () => void
}

export function CopisWorkingSettingsPanel({ onClose }: CopisWorkingSettingsPanelProps): React.ReactElement {
  const [authState, setAuthState] = useAtom(workingAuthStateAtom)
  const setWorkingVipStatus = useSetAtom(workingVipStatusAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [, setActiveTabId] = useAtom(activeTabIdAtom)
  const openPayment = useSetAtom(openWorkingPaymentAtom)
  const closePayment = useSetAtom(closeWorkingPaymentAtom)
  const paymentRefresh = useAtomValue(workingPaymentRefreshAtom)
  const paymentNotice = useAtomValue(workingPaymentNoticeAtom)
  const setPaymentNotice = useSetAtom(workingPaymentNoticeAtom)
  const requestPaymentRefresh = useSetAtom(requestWorkingPaymentRefreshAtom)
  const paymentRefreshRef = React.useRef(paymentRefresh)
  const [settings, setSettings] = React.useState<WorkingSettingsSnapshot | null>(null)
  const [activeSection, setActiveSection] = useAtom(workingSettingsSectionAtom)
  const [loading, setLoading] = React.useState(true)
  const [checkingIn, setCheckingIn] = React.useState(false)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [copiedLabel, setCopiedLabel] = React.useState('')
  const hasUpdate = useAtomValue(hasUpdateAtom)

  const user = settings?.user ?? authState?.user
  const isVip = settings?.vip?.isVip ?? user?.isVip === true
  const activeSectionDefinition = WORKING_SETTINGS_MENU.find((item) => item.id === activeSection) ?? WORKING_SETTINGS_MENU[0]!
  const ActiveIcon = activeSectionDefinition.icon

  const loadSettings = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const snapshot = await window.electronAPI.getWorkingSettingsSnapshot()
      setSettings(snapshot)
      setWorkingVipStatus(snapshot.vip)
      setAuthState((current) => ({
        authenticated: true,
        user: snapshot.user,
        backendUrl: current?.backendUrl ?? '',
      }))
    } catch (loadError) {
      console.error('[Copis 设置] 加载账户设置失败:', loadError)
      setError(loadError instanceof Error ? loadError.message : '加载 Copis 设置失败')
    } finally {
      setLoading(false)
    }
  }, [setAuthState, setWorkingVipStatus])

  const handleRefresh = React.useCallback(async (): Promise<void> => {
    requestPaymentRefresh()
    await loadSettings()
  }, [loadSettings, requestPaymentRefresh])

  React.useEffect(() => {
    void loadSettings()
  }, [loadSettings])

  React.useEffect(() => {
    if (paymentRefresh <= paymentRefreshRef.current) return
    paymentRefreshRef.current = paymentRefresh
    void loadSettings()
  }, [loadSettings, paymentRefresh])

  React.useEffect(() => {
    if (!paymentNotice) return undefined
    setNotice(paymentNotice)
    setPaymentNotice(null)
    return undefined
  }, [paymentNotice, setPaymentNotice])

  React.useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  const handleCheckIn = async (): Promise<void> => {
    if (checkingIn || settings?.hasCheckedIn) return
    setCheckingIn(true)
    setError('')
    try {
      const result = await window.electronAPI.checkInWorking()
      setSettings((current) => current ? {
        ...current,
        hasCheckedIn: true,
        user: { ...current.user, tokens: result.tokens },
        vip: current.vip ? { ...current.vip, tokens: result.tokens, diamonds: result.tokens } : current.vip,
      } : current)
      setAuthState((current) => {
        if (!current?.user) return current
        return {
          ...current,
          user: { ...current.user, tokens: result.tokens },
        }
      })
      setNotice(`签到成功，获得 ${formatTokens(result.reward)} 钻石`)
    } catch (checkInError) {
      setError(checkInError instanceof Error ? checkInError.message : '签到失败，请稍后重试')
    } finally {
      setCheckingIn(false)
    }
  }

  const handleCopyInvite = async (): Promise<void> => {
    const inviteCode = settings?.inviteCode
    if (!inviteCode) {
      setNotice('暂时没有可用的邀请码，请刷新后重试')
      return
    }
    await navigator.clipboard?.writeText(inviteCode)
    setCopiedLabel('已复制')
    window.setTimeout(() => setCopiedLabel(''), 1600)
  }

  const handleReceiveChannelChange = (receiveChannel: WorkingReceiveChannelSettings): void => {
    setSettings((current) => current ? { ...current, receiveChannel } : current)
  }

  const handleOpenTutorial = (): void => {
    const result = openTab(tabs, {
      type: 'tutorial',
      sessionId: TUTORIAL_TAB_ID,
      title: TUTORIAL_TAB_TITLE,
    })
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    onClose()
  }

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true)
    setError('')
    try {
      setAuthState(await window.electronAPI.logoutWorking())
      closePayment()
      onClose()
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : '退出登录失败')
    } finally {
      setLoggingOut(false)
    }
  }

  const leftSidebarWidth = useAtomValue(leftSidebarWidthAtom)
  const sidebarWidth = Math.max(200, Math.min(400, leftSidebarWidth || 240))

  return (
    <div className="copis-working-settings-view">
      <div className="copis-working-settings-shell">
        <aside className="copis-working-settings-sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth }}>
          <div className="copis-working-settings-sidebar-body">
            <nav className="copis-working-settings-nav" aria-label="Copis 设置菜单">
              <button type="button" className="copis-working-settings-nav-button" onClick={onClose}>
                <ArrowLeft aria-hidden="true" />
                <span>返回对话</span>
              </button>
              <div className="copis-working-settings-nav-divider" />
              {WORKING_SETTINGS_MENU.map((item) => {
                const isActive = item.id === activeSection
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`copis-working-settings-nav-button ${isActive ? 'active' : ''}`}
                    onClick={() => item.id === 'tutorial' ? handleOpenTutorial() : setActiveSection(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={item.id === 'about' && hasUpdate ? '关于/更新，有可用更新' : undefined}
                  >
                    <item.icon aria-hidden="true" />
                    <div className="copis-working-settings-nav-label-wrap">
                      <span>{item.label}</span>
                      {item.id === 'about' && hasUpdate && (
                        <span className="copis-working-settings-nav-update-dot" aria-label="有可用更新" />
                      )}
                    </div>
                  </button>
                )
              })}
            </nav>
          </div>
        </aside>

        <main className="copis-working-settings-main">
          {notice && <div className="copis-working-settings-toast" role="status" aria-live="polite"><CircleCheck aria-hidden="true" /><span>{notice}</span></div>}
          <header className="copis-working-settings-header">
            <div className="copis-working-settings-heading">
              <div className="copis-working-settings-heading-title">
                <ActiveIcon aria-hidden="true" />
                <h1>{activeSectionDefinition.label}</h1>
              </div>
              <p>{activeSectionDefinition.description}</p>
            </div>
            <div className="copis-working-settings-actions">
              {activeSection === 'settings' && (
                <button type="button" className="check-in" onClick={() => void handleCheckIn()} disabled={loading || checkingIn || settings?.hasCheckedIn === true}>
                  <CircleCheck aria-hidden="true" />
                  <span>{checkingIn ? '签到中...' : settings?.hasCheckedIn ? '已签到' : '每日签到'}</span>
                </button>
              )}
              <button type="button" onClick={() => void handleRefresh()} disabled={loading || loggingOut}>
                <RefreshCw aria-hidden="true" className={loading ? 'spinning' : undefined} />
                <span>{loading ? '同步中...' : '刷新'}</span>
              </button>
              <button type="button" className="danger" onClick={() => void handleLogout()} disabled={loading || loggingOut}>
                <LogOut aria-hidden="true" />
                <span>{loggingOut ? '退出中...' : '退出'}</span>
              </button>
            </div>
          </header>

          {error && <div className="copis-working-settings-alert" role="alert">{error}</div>}

          <div className="copis-working-settings-content">
            {activeSection === 'settings' && (
              <WorkingAccountSettings
                settings={settings}
                user={user}
                loading={loading}
                copiedLabel={copiedLabel}
                onNotice={setNotice}
                onCopyInvite={() => void handleCopyInvite()}
                onOpenDiamonds={() => openPayment({ mode: 'diamonds' })}
                onOpenVip={() => openPayment({ mode: 'vip' })}
              />
            )}
            {activeSection === 'model-management' && (
              <ModelManagementSettings
                isVip={isVip}
                accountId={user?.id === undefined && user?.userId === undefined
                  ? undefined
                  : String(user.id ?? user.userId)}
                onOpenVip={() => openPayment({ mode: 'vip' })}
                onNotice={setNotice}
              />
            )}
            {activeSection === 'messages' && (
              <CopisWorkingMessageSettingsPanel
                settings={settings?.receiveChannel ?? null}
                onSettingsChange={handleReceiveChannelChange}
                onRefresh={loadSettings}
              />
            )}
            {activeSection === 'orders' && <CopisWorkingOrdersPanel />}
            {activeSection === 'voice-input' && <VoiceInputSettings />}
            {activeSection === 'migration' && <MigrationSettings />}
            {activeSection === 'storage' && <StorageSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
            {activeSection === 'about' && <AboutUpdatesSettings />}
          </div>
        </main>
      </div>
    </div>
  )
}

interface WorkingAccountSettingsProps {
  settings: WorkingSettingsSnapshot | null
  user: WorkingUser | null | undefined
  loading: boolean
  copiedLabel: string
  onNotice: (message: string) => void
  onCopyInvite: () => void
  onOpenDiamonds: () => void
  onOpenVip: () => void
}

function WorkingAccountSettings({
  settings,
  user,
  loading,
  copiedLabel,
  onNotice,
  onCopyInvite,
  onOpenDiamonds,
  onOpenVip,
}: WorkingAccountSettingsProps): React.ReactElement {
  const LEDGER_PAGE_SIZE = 8
  const [ledgerTab, setLedgerTab] = React.useState<'consumption' | 'purchase'>('consumption')
  const [ledgerPage, setLedgerPage] = React.useState(1)
  const diamondBalance = settings?.vip?.diamonds ?? user?.tokens ?? 0
  const tokenBalance = formatTokens(diamondBalance)
  const estimatedConversationCount = Math.floor(diamondBalance / 0.5)
  const isVip = settings?.vip?.isVip ?? user?.isVip === true
  const vipExpiresAt = settings?.vip?.vipExpiresAt ?? user?.vipExpiresAt ?? null
  const memberNameMap = React.useMemo(
    () => new Map((settings?.members ?? []).map((member) => [
      String(member.userId),
      member.displayName || member.email || `用户 ${member.userId}`,
    ])),
    [settings?.members],
  )
  const personalLedger = settings?.ledger ?? []
  const consumptionLedger = React.useMemo(
    () => selectWorkingConsumptionLedgerEntries(personalLedger),
    [personalLedger],
  )
  const purchaseLedger = React.useMemo(
    () => personalLedger.filter((entry) => entry.type === 'purchase'),
    [personalLedger],
  )
  const selectedLedger = ledgerTab === 'consumption' ? consumptionLedger : purchaseLedger
  const ledgerPagination = React.useMemo(
    () => paginateWorkingLedgerEntries(selectedLedger, ledgerPage, LEDGER_PAGE_SIZE),
    [ledgerPage, selectedLedger],
  )
  const dailyConsumption = React.useMemo(() => {
    const today = new Date().toDateString()
    return personalLedger.reduce((total, entry) => {
      if (entry.type !== 'charge' || !entry.createdAt || new Date(entry.createdAt).toDateString() !== today) return total
      return total + entry.amountTokens
    }, 0)
  }, [personalLedger])

  React.useEffect(() => {
    setLedgerPage(1)
  }, [ledgerTab, settings])

  return (
    <div className="copis-working-settings-grid">
      <section className="copis-working-settings-card copis-working-settings-balance-card">
        <div className="copis-working-settings-card-heading copis-working-settings-card-heading-with-action">
          <div className="copis-working-settings-card-heading-title">
            <Gem aria-hidden="true" />
            <span>个人钻石</span>
          </div>
          <button type="button" className="copis-working-settings-card-action copis-working-settings-primary-button" onClick={onOpenDiamonds} disabled={loading}>
            <Gem aria-hidden="true" />
            <span>获取钻石</span>
          </button>
        </div>
        <strong className="copis-working-settings-balance">{loading ? '--' : tokenBalance}</strong>
        <span className="copis-working-settings-balance-conversation-count">
          预计 {loading ? '--' : formatTokens(estimatedConversationCount)} 次对话
        </span>
      </section>

      <section className="copis-working-settings-card copis-working-settings-vip-card">
        <div className="copis-working-settings-card-heading copis-working-settings-card-heading-with-action">
          <div className="copis-working-settings-card-heading-title">
            <Crown aria-hidden="true" />
            <span>VIP</span>
          </div>
          <button type="button" className="copis-working-settings-card-action copis-working-settings-vip-button" onClick={onOpenVip} disabled={loading || settings?.vip?.upgradeAvailable === false}>
            <Crown aria-hidden="true" />
            <span>{settings?.vip?.upgradeAvailable === false ? 'VIP 暂未开放' : isVip ? '续费 VIP' : '升级 VIP'}</span>
          </button>
        </div>
        <strong>{isVip ? '已开通' : '未开通'}</strong>
        <p>{isVip
          ? '钻石消耗节省 20%，可使用专家团队和定时任务。'
          : '钻石按标准消耗，专家团队和定时任务暂不可用。'}
        </p>
        {isVip && vipExpiresAt && <span className="copis-working-settings-vip-expiry">有效期至 {formatDate(vipExpiresAt)}</span>}
      </section>

      <section className="copis-working-settings-card copis-working-settings-invite-card">
        <div className="copis-working-settings-card-heading copis-working-settings-card-heading-with-action">
          <div className="copis-working-settings-card-heading-title">
            <UserRound aria-hidden="true" />
            <span>邀请</span>
          </div>
          <button
            type="button"
            className="copis-working-settings-card-action copis-working-settings-invite-button"
            onClick={onCopyInvite}
            disabled={!settings?.inviteCode}
            aria-label="复制邀请码"
          >
            {copiedLabel ? <CircleCheck aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
            <span>{copiedLabel || '复制邀请码'}</span>
          </button>
        </div>
        <p>邀请好友使用，获取钻石奖励</p>
        <div className="copis-working-settings-invite-code">
          <span>{settings?.inviteCode || (loading ? '正在获取邀请码' : '暂无邀请码')}</span>
        </div>
        <span className="copis-working-settings-invite-user-count">已邀请 {settings?.invitedUsers.length ?? 0} 位用户</span>
      </section>

      <section className="copis-working-settings-card copis-working-settings-ledger-card">
        <div className="copis-working-settings-card-heading copis-working-settings-ledger-heading">
          <div className="copis-working-settings-ledger-heading-title">
            <Sparkles aria-hidden="true" />
            <span>个人钻石流水</span>
          </div>
          <div className="copis-working-settings-ledger-daily-total" hidden={ledgerTab !== 'consumption'}>
            <span>每日消耗累计</span>
            <strong>{formatTokens(dailyConsumption)}</strong>
          </div>
        </div>
        <div className="copis-working-settings-ledger-tabs" role="tablist" aria-label="钻石流水分类">
          <button
            type="button"
            role="tab"
            aria-selected={ledgerTab === 'consumption'}
            className={ledgerTab === 'consumption' ? 'active' : undefined}
            onClick={() => setLedgerTab('consumption')}
          >
            消耗
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={ledgerTab === 'purchase'}
            className={ledgerTab === 'purchase' ? 'active' : undefined}
            onClick={() => setLedgerTab('purchase')}
          >
            获取
          </button>
        </div>
        <div className="copis-working-settings-ledger-list">
          {ledgerPagination.items.length > 0 ? ledgerPagination.items.map((entry) => (
            <LedgerRow key={String(entry.id)} entry={entry} memberNameMap={memberNameMap} />
          )) : (
            <div className="copis-working-settings-empty">
              <Sparkles aria-hidden="true" />
              <span>{loading ? '正在读取流水...' : ledgerTab === 'consumption' ? '暂无钻石消耗记录' : '暂无钻石获取记录'}</span>
            </div>
          )}
        </div>
        {ledgerPagination.totalPages > 1 && (
          <nav className="copis-working-settings-ledger-pagination" aria-label="钻石流水分页">
            <button
              type="button"
              disabled={ledgerPagination.page <= 1}
              onClick={() => setLedgerPage(1)}
              aria-label="首页"
              title="首页"
            >
              <ChevronsLeft aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={ledgerPagination.page <= 1}
              onClick={() => setLedgerPage((page) => page - 1)}
              aria-label="上一页"
              title="上一页"
            >
              <ChevronLeft aria-hidden="true" />
            </button>
            <span>
              第 {ledgerPagination.page} / {ledgerPagination.totalPages} 页（共 {selectedLedger.length} 条）
            </span>
            <button
              type="button"
              disabled={ledgerPagination.page >= ledgerPagination.totalPages}
              onClick={() => setLedgerPage((page) => page + 1)}
              aria-label="下一页"
              title="下一页"
            >
              <ChevronRight aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={ledgerPagination.page >= ledgerPagination.totalPages}
              onClick={() => setLedgerPage(ledgerPagination.totalPages)}
              aria-label="末页"
              title="末页"
            >
              <ChevronsRight aria-hidden="true" />
            </button>
          </nav>
        )}
      </section>
    </div>
  )
}

function LedgerRow({ entry, memberNameMap }: { entry: WorkingLedgerEntry; memberNameMap: Map<string, string> }): React.ReactElement {
  const amount = getLedgerAmount(entry)
  const title = getLedgerTitle(entry)
  const payer = memberNameMap.get(String(entry.payerUserId)) || `用户 ${entry.payerUserId}`
  return (
    <article className="copis-working-settings-ledger-row">
      <div>
        <div className="copis-working-settings-ledger-title"><strong>{title}</strong></div>
        <span>{formatWorkingLedgerDescription(entry, payer)}</span>
      </div>
      <div className={amount >= 0 ? 'positive' : 'negative'}>
        <b>{amount >= 0 ? '+' : ''}{formatTokens(amount)}</b>
        <time dateTime={entry.createdAt}>{formatLedgerTime(entry.createdAt)}</time>
      </div>
    </article>
  )
}

function getLedgerTitle(entry: WorkingLedgerEntry): string {
  if (entry.type === 'purchase') return '获取钻石'
  if (entry.type === 'transfer') return '成员转账'
  if (entry.type === 'reward' || entry.sourceType === 'daily_checkin') return '每日签到'
  // pi_office_model 保留为专家团模型专用分类；Copis 内置 Agent 模型使用 copis-agent-model。
  if (entry.sourceType === 'pi_office_model') return '专家团扣费'
  if (isWorkingModelDeduction(entry) && entry.modelAlias) {
    const discount = formatWorkingDiscount(entry.discount ?? entry.deductionMultiplier)
    return discount ? `Copis 模型扣费（${discount}）` : 'Copis 模型扣费'
  }
  return 'AI 扣费'
}

function getLedgerAmount(entry: WorkingLedgerEntry): number {
  if (entry.type === 'purchase' || entry.type === 'reward') return entry.amountTokens
  return -entry.amountTokens
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0)
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function formatLedgerTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
