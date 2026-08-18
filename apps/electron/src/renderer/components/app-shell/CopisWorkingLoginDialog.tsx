import * as React from 'react'
import { Loader2, LogIn, X } from 'lucide-react'
import type { WorkingAuthState } from '@copis/shared'
import { cn } from '@/lib/utils'
import { CopisAppLogo } from '@/lib/model-logo'
import { CopisWorkingLoginShowcase } from './CopisWorkingLoginShowcase'
import './CopisWorkingLoginDialog.css'

interface CopisWorkingLoginDialogProps {
  initialEmail?: string
  dismissible?: boolean
  onClose: () => void
  onAuthenticated: (state: WorkingAuthState) => void
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : '登录失败，请重试'
}

export function CopisWorkingLoginDialog({
  dismissible = true,
  onClose,
  onAuthenticated,
}: CopisWorkingLoginDialogProps): React.ReactElement {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const oauthButtonRef = React.useRef<HTMLButtonElement>(null)
  const isFullPage = !dismissible

  React.useEffect(() => {
    oauthButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (dismissible && event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, dismissible, onClose])

  const handleOAuthLogin = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const state = await window.electronAPI.loginWorkingWithOAuth()
      onAuthenticated(state)
    } catch (loginError) {
      setError(getErrorMessage(loginError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn('copis-working-auth-backdrop', isFullPage && 'copis-working-auth-page')}
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget && !busy) onClose()
      }}
    >
      {isFullPage && <CopisWorkingLoginShowcase />}
      <section
        className={cn('copis-working-auth-modal', isFullPage && 'copis-working-auth-panel')}
        role={dismissible ? 'dialog' : undefined}
        aria-modal={dismissible ? true : undefined}
        aria-labelledby="copis-working-auth-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="copis-working-auth-top">
          <div className="copis-working-auth-brand">
            <span className="copis-working-auth-brand-icon" aria-hidden="true"><img src={CopisAppLogo} alt="" /></span>
            <span>Copis 账户</span>
          </div>
          {dismissible && (
            <button type="button" className="copis-working-auth-close" aria-label="关闭登录窗口" onClick={onClose} disabled={busy}>
              <X size={18} />
            </button>
          )}
        </div>

        <header className="copis-working-auth-header">
          <h1 id="copis-working-auth-title">欢迎回来</h1>
          <p>登录后继续进入你的工作空间。</p>
        </header>

        <div className="copis-working-auth-oauth-card">
          <div className="copis-working-auth-oauth-mark" aria-hidden="true">
            <LogIn size={20} />
          </div>
          <div>
            <strong>使用 ai-edu 统一账号</strong>
            <p>注册、登录和密码找回将在系统浏览器中完成。</p>
          </div>
        </div>

        {error && <p className="copis-working-auth-message error" role="alert">{error}</p>}

        <button
          ref={oauthButtonRef}
          type="button"
          className="copis-working-auth-oauth"
          onClick={() => void handleOAuthLogin()}
          disabled={busy}
        >
          {busy && <Loader2 size={17} className="animate-spin" />}
          {busy ? '正在打开 ai-edu...' : '使用 ai-edu 账号登录'}
        </button>

        <div className="copis-working-auth-persisted-note">
          <span className="copis-working-auth-check" aria-hidden="true">✓</span>
          登录状态和用户信息将安全保存在本机
        </div>
      </section>
    </div>
  )
}
