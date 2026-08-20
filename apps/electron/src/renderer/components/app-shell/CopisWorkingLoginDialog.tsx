import * as React from 'react'
import { Loader2, LogIn, X } from 'lucide-react'
import type { WorkingAuthState } from '@copis/shared'
import { cn } from '@/lib/utils'
import { CopisAppLogo } from '@/lib/model-logo'
import PiLogo from '@/assets/pi-logo.svg'
import { CopisWorkingLoginShowcase } from './CopisWorkingLoginShowcase'
import './CopisWorkingLoginDialog.css'

interface CopisWorkingLoginDialogProps {
  dismissible?: boolean
  onClose: () => void
  onAuthenticated: (state: WorkingAuthState) => void
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : 'Pi 账号授权失败，请重试'
}

export function CopisWorkingLoginDialog({
  dismissible = true,
  onClose,
  onAuthenticated,
}: CopisWorkingLoginDialogProps): React.ReactElement {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const isFullPage = !dismissible

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (dismissible && event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, dismissible, onClose])

  const handleOAuthLogin = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy) return

    setError('')
    setBusy(true)
    try {
      const state = await window.electronAPI.loginWorkingWithOAuth()
      onAuthenticated(state)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
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
        aria-busy={busy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="copis-working-auth-top">
          <div className="copis-working-auth-brand">
            <span className="copis-working-auth-brand-icon" aria-hidden="true"><img src={CopisAppLogo} alt="" /></span>
            <span>Copis 账户</span>
          </div>
          <div className="copis-working-auth-partner" aria-label="Copis 账户与 Pi 账户">
            <span className="copis-working-auth-partner-separator" aria-hidden="true">×</span>
            <span className="copis-working-auth-pi-brand">
              <img className="copis-working-auth-pi-logo" src={PiLogo} alt="" aria-hidden="true" />
              <span>Pi 账户</span>
            </span>
          </div>
          {dismissible && (
            <button type="button" className="copis-working-auth-close" aria-label="关闭登录窗口" onClick={onClose} disabled={busy}>
              <X size={18} />
            </button>
          )}
        </div>

        <div className="copis-working-auth-content">
          <header className="copis-working-auth-header">
            <h1 id="copis-working-auth-title">欢迎回来</h1>
            <p>登录后继续进入你的工作空间。注册、登录和密码找回将在系统浏览器中完成。</p>
          </header>

          <form className="copis-working-auth-form" onSubmit={(event) => void handleOAuthLogin(event)}>
            {error && <p className="copis-working-auth-message error" role="alert">{error}</p>}

            <button type="submit" className="copis-working-auth-submit" disabled={busy}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}
              {busy ? '正在等待 Pi 授权...' : '使用 Pi 账号登录'}
            </button>

            <div className="copis-working-auth-persisted-note">
              <span className="copis-working-auth-check" aria-hidden="true">✓</span>
              登录状态和用户信息将安全保存在本机
            </div>
          </form>
        </div>
      </section>
    </div>
  )
}
