import * as React from 'react'
import { useAtom } from 'jotai'
import {
  ArrowLeft,
  Clipboard,
  CircleCheck,
  ClipboardList,
  Crown,
  Gem,
  LogOut,
  MessageSquare,
  RefreshCw,
  Sparkles,
  UserRound,
} from 'lucide-react'
import type {
  WorkingLedgerEntry,
  WorkingSettingsSnapshot,
} from '@proma/shared'
import { workingAuthStateAtom } from '@/atoms/working-atoms'
import { CopisWorkingMessageSettingsPanel } from './CopisWorkingMessageSettingsPanel'
import { CopisWorkingOrdersPanel } from './CopisWorkingOrdersPanel'
import './CopisWorkingSettingsPanel.css'

interface CopisWorkingSettingsPanelProps {
  onClose: () => void
}

export function CopisWorkingSettingsPanel({ onClose }: CopisWorkingSettingsPanelProps): React.ReactElement {
  const [authState, setAuthState] = useAtom(workingAuthStateAtom)
  const [settings, setSettings] = React.useState<WorkingSettingsSnapshot | null>(null)
  const [activeSection, setActiveSection] = React.useState<'settings' | 'orders' | 'messages'>('settings')
  const [loading, setLoading] = React.useState(true)
  const [checkingIn, setCheckingIn] = React.useState(false)
  const [loggingOut, setLoggingOut] = React.useState(false)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [copiedLabel, setCopiedLabel] = React.useState('')

  const user = settings?.user ?? authState?.user
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

  const loadSettings = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const snapshot = await window.electronAPI.getWorkingSettingsSnapshot()
      setSettings(snapshot)
      setAuthState((current) => ({
        authenticated: true,
        user: snapshot.user,
        backendUrl: current?.backendUrl || '',
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
      setAuthState((current) => current && settings?.user
        ? { ...current, user: { ...settings.user, tokens: result.tokens } }
        : current)
      setNotice(`签到成功，获得 ${formatTokens(result.reward)} 钻石`)
    } catch (checkInError) {
      setError(checkInError instanceof Error ? checkInError.message : '签到失败，请稍后重试')
    } finally {
      setCheckingIn(false)
    }
  }

  const handleCopyInvite = async (): Promise<void> => {
    const inviteText = settings?.inviteLink || settings?.inviteCode
    if (!inviteText) {
      setNotice('暂时没有可用的邀请码，请刷新后重试')
      return
    }
    await navigator.clipboard?.writeText(inviteText)
    setCopiedLabel(settings?.inviteLink ? '邀请链接' : '邀请码')
    window.setTimeout(() => setCopiedLabel(''), 1600)
  }

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true)
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
            <button type="button" className={`copis-working-settings-nav-button ${activeSection === 'settings' ? 'active' : ''}`} onClick={() => setActiveSection('settings')}>
              <UserRound aria-hidden="true" />
              <span>账户设置</span>
            </button>
            <button type="button" className={`copis-working-settings-nav-button ${activeSection === 'messages' ? 'active' : ''}`} onClick={() => setActiveSection('messages')}>
              <MessageSquare aria-hidden="true" />
              <span>工作消息接收方式</span>
            </button>
            <button type="button" className={`copis-working-settings-nav-button ${activeSection === 'orders' ? 'active' : ''}`} onClick={() => setActiveSection('orders')}>
              <ClipboardList aria-hidden="true" />
              <span>我的订单</span>
            </button>
          </nav>
        </aside>

        <main className="copis-working-settings-main">
          {notice && <div className="copis-working-settings-toast" role="status" aria-live="polite"><CircleCheck aria-hidden="true" /><span>{notice}</span></div>}
          <header className="copis-working-settings-header">
            <div>
              <h1>{activeSection === 'orders' ? '我的订单' : activeSection === 'messages' ? '工作消息接收方式' : '设置'}</h1>
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

          {activeSection === 'orders' ? <CopisWorkingOrdersPanel /> : activeSection === 'messages' ? <CopisWorkingMessageSettingsPanel /> : (
          <div className="copis-working-settings-grid">
            <section className="copis-working-settings-card copis-working-settings-balance-card">
              <div className="copis-working-settings-card-heading copis-working-settings-card-heading-with-action">
                <div className="copis-working-settings-card-heading-title">
                  <Gem aria-hidden="true" />
                  <span>个人钻石</span>
                </div>
                <button type="button" className="copis-working-settings-card-action copis-working-settings-primary-button" onClick={() => setNotice('钻石充值将在 Working 支付模块开放。')}>
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
                <button type="button" className="copis-working-settings-card-action copis-working-settings-vip-button" onClick={() => setNotice('VIP 支付将在 Working 支付模块开放。')}>
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
              <div className="copis-working-settings-card-heading">
                <UserRound aria-hidden="true" />
                <span>邀请</span>
              </div>
              <p>一个账号体验家庭与工作两种空间，分享 π 的陪伴与交付能力。</p>
              <div className="copis-working-settings-invite-code">
                <span>{settings?.inviteCode || (loading ? '正在获取邀请码' : '暂无邀请码')}</span>
                <button type="button" onClick={() => void handleCopyInvite()} disabled={!settings?.inviteCode && !settings?.inviteLink} aria-label="复制邀请信息">
                  <Clipboard aria-hidden="true" />
                  <span>{copiedLabel || '复制'}</span>
                </button>
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
          )}
        </main>
      </div>
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
        <span>{entry.memo ? `${payer} / ${entry.memo}` : payer}</span>
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
  if (entry.sourceType === 'pi_office_model') return '专家团扣费'
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
