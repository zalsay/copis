import * as React from 'react'
import { useAtom } from 'jotai'
import {
  ArrowLeft,
  Clipboard,
  CircleCheck,
  ClipboardList,
  Crown,
  Gem,
  GraduationCap,
  HardDrive,
  HardDriveDownload,
  LogOut,
  MessageSquare,
  Mic,
  Palette,
  RefreshCw,
  Sparkles,
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
  type WorkingSettingsSectionId,
} from '@/atoms/working-atoms'
import { activeTabIdAtom, openTab, tabsAtom, TUTORIAL_TAB_ID, TUTORIAL_TAB_TITLE } from '@/atoms/tab-atoms'
import { AppearanceSettings } from '@/components/settings/AppearanceSettings'
import { MigrationSettings } from '@/components/settings/MigrationSettings'
import { StorageSettings } from '@/components/settings/StorageSettings'
import { VoiceInputSettings } from '@/components/settings/VoiceInputSettings'
import { formatWorkingLedgerDescription, isWorkingModelDeduction } from '@/lib/working-ledger'
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
    id: 'messages',
    label: '工作消息接收方式',
    description: '选择 Working 工作消息的接收渠道并查看绑定状态。',
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
] as const

interface CopisWorkingSettingsPanelProps {
  onClose: () => void
}

export function CopisWorkingSettingsPanel({ onClose }: CopisWorkingSettingsPanelProps): React.ReactElement {
  const [authState, setAuthState] = useAtom(workingAuthStateAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const [, setActiveTabId] = useAtom(activeTabIdAtom)
  const [settings, setSettings] = React.useState<WorkingSettingsSnapshot | null>(null)
  const [activeSection, setActiveSection] = useAtom(workingSettingsSectionAtom)
  const [loading, setLoading] = React.useState(true)
  const [checkingIn, setCheckingIn] = React.useState(false)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [copiedLabel, setCopiedLabel] = React.useState('')

  const user = settings?.user ?? authState?.user
  const activeSectionDefinition = WORKING_SETTINGS_MENU.find((item) => item.id === activeSection) ?? WORKING_SETTINGS_MENU[0]!
  const ActiveIcon = activeSectionDefinition.icon

  const loadSettings = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const snapshot = await window.electronAPI.getWorkingSettingsSnapshot()
      setSettings(snapshot)
      setAuthState((current) => ({
        authenticated: true,
        user: snapshot.user,
        backendUrl: current?.backendUrl ?? '',
      }))
    } catch (loadError) {
      console.error('[Working 设置] 加载账户设置失败:', loadError)
      setError(loadError instanceof Error ? loadError.message : '加载 Working 设置失败')
    } finally {
      setLoading(false)
    }
  }, [setAuthState])

  React.useEffect(() => {
    void loadSettings()
  }, [loadSettings])

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
      onClose()
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : '退出登录失败')
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="copis-working-settings-view">
      <div className="copis-working-settings-shell">
        <aside className="copis-working-settings-sidebar">
          <nav className="copis-working-settings-nav" aria-label="Working 设置菜单">
            <button type="button" className="copis-working-settings-nav-button" onClick={onClose}>
              <ArrowLeft aria-hidden="true" />
              <span>返回对话</span>
            </button>
            {WORKING_SETTINGS_MENU.map((item) => {
              const isActive = item.id === activeSection
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`copis-working-settings-nav-button ${isActive ? 'active' : ''}`}
                  onClick={() => item.id === 'tutorial' ? handleOpenTutorial() : setActiveSection(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <item.icon aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              )
            })}
          </nav>
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
              {activeSection === 'settings' && (
                <button type="button" onClick={() => void loadSettings()} disabled={loading || loggingOut}>
                  <RefreshCw aria-hidden="true" className={loading ? 'spinning' : undefined} />
                  <span>{loading ? '同步中...' : '刷新'}</span>
                </button>
              )}
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
              />
            )}
            {activeSection === 'messages' && (
              <CopisWorkingMessageSettingsPanel
                settings={settings?.receiveChannel ?? null}
                onSettingsChange={handleReceiveChannelChange}
              />
            )}
            {activeSection === 'orders' && <CopisWorkingOrdersPanel />}
            {activeSection === 'voice-input' && <VoiceInputSettings />}
            {activeSection === 'migration' && <MigrationSettings />}
            {activeSection === 'storage' && <StorageSettings />}
            {activeSection === 'appearance' && <AppearanceSettings />}
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
}

function WorkingAccountSettings({
  settings,
  user,
  loading,
  copiedLabel,
  onNotice,
  onCopyInvite,
}: WorkingAccountSettingsProps): React.ReactElement {
  const tokenBalance = formatTokens(settings?.vip?.diamonds ?? user?.tokens ?? 0)
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
  const dailyConsumption = React.useMemo(() => {
    const today = new Date().toDateString()
    return personalLedger.reduce((total, entry) => {
      if (entry.type !== 'charge' || !entry.createdAt || new Date(entry.createdAt).toDateString() !== today) return total
      return total + entry.amountTokens
    }, 0)
  }, [personalLedger])

  return (
    <div className="copis-working-settings-grid">
      <section className="copis-working-settings-card copis-working-settings-balance-card">
        <div className="copis-working-settings-card-heading copis-working-settings-card-heading-with-action">
          <div className="copis-working-settings-card-heading-title">
            <Gem aria-hidden="true" />
            <span>个人钻石</span>
          </div>
          <button type="button" className="copis-working-settings-card-action copis-working-settings-primary-button" onClick={() => onNotice('钻石充值将在 Working 支付模块开放。')}>
            <Gem aria-hidden="true" />
            <span>获取钻石</span>
          </button>
        </div>
        <strong className="copis-working-settings-balance">{loading ? '--' : tokenBalance}</strong>
        <p>用于 Working 与创作任务的 AI 消耗</p>
      </section>

      <section className="copis-working-settings-card copis-working-settings-vip-card">
        <div className="copis-working-settings-card-heading copis-working-settings-card-heading-with-action">
          <div className="copis-working-settings-card-heading-title">
            <Crown aria-hidden="true" />
            <span>VIP</span>
          </div>
          <button type="button" className="copis-working-settings-card-action copis-working-settings-vip-button" onClick={() => onNotice('VIP 支付将在 Working 支付模块开放。')}>
            <Crown aria-hidden="true" />
            <span>{isVip ? '查看 VIP 权益' : '升级 VIP'}</span>
          </button>
        </div>
        <strong>{isVip ? '已开通' : '未开通'}</strong>
        <p>
          云文档容量 {settings?.vip?.quotaLabel || (isVip ? '5G' : '500M')}。
          {isVip && vipExpiresAt ? ` 有效期至 ${formatDate(vipExpiresAt)}。` : ` 支付后提升到 5G，有效期 ${settings?.vip?.upgradeDays || 30} 天。`}
        </p>
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
        <p>一个账号体验家庭与工作两种空间，分享 π 的陪伴与交付能力。</p>
        <div className="copis-working-settings-invite-code">
          <span>{settings?.inviteCode || (loading ? '正在获取邀请码' : '暂无邀请码')}</span>
        </div>
        <div className="copis-working-settings-invite-stats">
          <strong>{settings?.invitedUsers.length ?? 0}</strong>
          <span>已邀请用户</span>
        </div>
      </section>

      <section className="copis-working-settings-card copis-working-settings-ledger-card">
        <div className="copis-working-settings-card-heading copis-working-settings-ledger-heading">
          <div className="copis-working-settings-ledger-heading-title">
            <Sparkles aria-hidden="true" />
            <span>个人钻石流水</span>
          </div>
          <div className="copis-working-settings-ledger-daily-total">
            <span>每日消耗累计</span>
            <strong>{formatTokens(dailyConsumption)}</strong>
          </div>
        </div>
        <div className="copis-working-settings-ledger-list">
          {personalLedger.length > 0 ? personalLedger.slice(0, 8).map((entry) => (
            <LedgerRow key={String(entry.id)} entry={entry} memberNameMap={memberNameMap} />
          )) : (
            <div className="copis-working-settings-empty">
              <Sparkles aria-hidden="true" />
              <span>{loading ? '正在读取流水...' : '暂无个人钻石流水'}</span>
            </div>
          )}
        </div>
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
  if (isWorkingModelDeduction(entry) && entry.modelAlias) return 'Copis 模型扣费'
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
