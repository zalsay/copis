import * as React from 'react'
import { KeyRound, Loader2, LogIn, Mail, UserPlus, X } from 'lucide-react'
import type { WorkingAuthState } from '@proma/shared'
import { cn } from '@/lib/utils'
import { CopisLogo } from '@/lib/model-logo'
import './CopisWorkingLoginDialog.css'

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
const VERIFICATION_COOLDOWN_SECONDS = 60

type AuthMode = 'login' | 'register'
type ForgotPasswordStep = 'email' | 'code' | 'password'

interface CopisWorkingLoginDialogProps {
  initialEmail?: string
  dismissible?: boolean
  onClose: () => void
  onAuthenticated: (state: WorkingAuthState) => void
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback
}

export function CopisWorkingLoginDialog({
  initialEmail = '',
  dismissible = true,
  onClose,
  onAuthenticated,
}: CopisWorkingLoginDialogProps): React.ReactElement {
  const [authMode, setAuthMode] = React.useState<AuthMode>('login')
  const [email, setEmail] = React.useState(initialEmail)
  const [password, setPassword] = React.useState('')
  const [nickname, setNickname] = React.useState('')
  const [invitationCode, setInvitationCode] = React.useState('')
  const [verificationCode, setVerificationCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [sendingCode, setSendingCode] = React.useState(false)
  const [countdown, setCountdown] = React.useState(0)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [forgotOpen, setForgotOpen] = React.useState(false)
  const [forgotStep, setForgotStep] = React.useState<ForgotPasswordStep>('email')
  const [forgotEmail, setForgotEmail] = React.useState(initialEmail)
  const [forgotCode, setForgotCode] = React.useState('')
  const [forgotPassword, setForgotPassword] = React.useState('')
  const [forgotConfirmPassword, setForgotConfirmPassword] = React.useState('')
  const [resetToken, setResetToken] = React.useState('')
  const [resetBusy, setResetBusy] = React.useState(false)
  const [resetSendingCode, setResetSendingCode] = React.useState(false)
  const [resetCountdown, setResetCountdown] = React.useState(0)
  const emailInputRef = React.useRef<HTMLInputElement>(null)

  const normalizedEmail = email.trim().toLowerCase()
  const normalizedForgotEmail = forgotEmail.trim().toLowerCase()
  const requiresVerificationCode = invitationCode.trim().length === 0

  React.useEffect(() => {
    emailInputRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (dismissible && event.key === 'Escape' && !busy && !resetBusy) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [busy, dismissible, onClose, resetBusy])

  React.useEffect(() => {
    if (countdown <= 0) return undefined
    const timer = window.setTimeout(() => setCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  React.useEffect(() => {
    if (resetCountdown <= 0) return undefined
    const timer = window.setTimeout(() => setResetCountdown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [resetCountdown])

  const resetMessages = (): void => {
    setError('')
    setNotice('')
  }

  const switchAuthMode = (mode: AuthMode): void => {
    if (busy) return
    resetMessages()
    setAuthMode(mode)
  }

  const validateEmail = (value: string): boolean => {
    if (!value) {
      setError('请输入邮箱地址')
      return false
    }
    if (!EMAIL_PATTERN.test(value)) {
      setError('请输入有效的邮箱地址')
      return false
    }
    return true
  }

  const handleSendCode = async (purpose: 'register' | 'password_reset'): Promise<void> => {
    const targetEmail = purpose === 'register' ? normalizedEmail : normalizedForgotEmail
    if (!validateEmail(targetEmail)) return
    if (purpose === 'register' && countdown > 0) return
    if (purpose === 'password_reset' && resetCountdown > 0) return

    resetMessages()
    if (purpose === 'register') setSendingCode(true)
    else setResetSendingCode(true)
    try {
      await window.electronAPI.sendWorkingVerificationCode({ email: targetEmail, purpose })
      if (purpose === 'register') setCountdown(VERIFICATION_COOLDOWN_SECONDS)
      else setResetCountdown(VERIFICATION_COOLDOWN_SECONDS)
      setNotice('验证码已发送，请查收邮件')
    } catch (requestError) {
      setError(getErrorMessage(requestError, '验证码发送失败，请重试'))
    } finally {
      if (purpose === 'register') setSendingCode(false)
      else setResetSendingCode(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    resetMessages()
    if (authMode === 'register') {
      if (!validateEmail(normalizedEmail)) return
    } else if (!normalizedEmail) {
      setError('请输入用户名或账号')
      return
    }
    if (!password) {
      setError('请输入密码')
      return
    }
    if (authMode === 'register' && password.length < 6) {
      setError('密码至少需要6位')
      return
    }
    if (authMode === 'register' && requiresVerificationCode && verificationCode.length !== 4) {
      setError('请输入4位验证码')
      return
    }

    setBusy(true)
    try {
      if (authMode === 'login') {
        const state = await window.electronAPI.loginWorking({ email: normalizedEmail, password })
        onAuthenticated(state)
        return
      }

      const registeredInvitationCode = invitationCode.trim()
      await window.electronAPI.registerWorking({
        email: normalizedEmail,
        password,
        nickname: nickname.trim() || undefined,
        invitationCode: registeredInvitationCode || undefined,
        verificationCode: requiresVerificationCode ? verificationCode : undefined,
      })
      if (registeredInvitationCode) {
        const state = await window.electronAPI.loginWorking({ email: normalizedEmail, password })
        onAuthenticated(state)
        return
      }
      setPassword('')
      setVerificationCode('')
      setAuthMode('login')
      setNotice('注册成功，请使用新账号登录')
    } catch (requestError) {
      setError(getErrorMessage(requestError, authMode === 'login' ? '登录失败，请重试' : '注册失败，请重试'))
    } finally {
      setBusy(false)
    }
  }

  const openForgotPassword = (): void => {
    resetMessages()
    setForgotEmail(normalizedEmail)
    setForgotCode('')
    setForgotPassword('')
    setForgotConfirmPassword('')
    setResetToken('')
    setForgotStep('email')
    setForgotOpen(true)
  }

  const closeForgotPassword = (): void => {
    if (resetBusy) return
    setForgotOpen(false)
    resetMessages()
  }

  const handleVerifyResetCode = async (): Promise<void> => {
    if (forgotCode.length !== 4) {
      setError('请输入4位验证码')
      return
    }
    setError('')
    setResetBusy(true)
    try {
      const result = await window.electronAPI.verifyWorkingPasswordResetCode({
        email: normalizedForgotEmail,
        code: forgotCode,
      })
      setResetToken(result.resetToken)
      setForgotStep('password')
    } catch (requestError) {
      setError(getErrorMessage(requestError, '验证码校验失败'))
    } finally {
      setResetBusy(false)
    }
  }

  const handleResetPassword = async (): Promise<void> => {
    if (forgotPassword.length < 6) {
      setError('新密码至少需要6位')
      return
    }
    if (forgotPassword !== forgotConfirmPassword) {
      setError('两次输入的新密码不一致')
      return
    }
    setError('')
    setResetBusy(true)
    try {
      await window.electronAPI.resetWorkingPassword({
        email: normalizedForgotEmail,
        resetToken,
        password: forgotPassword,
      })
      setEmail(normalizedForgotEmail)
      setPassword('')
      setForgotOpen(false)
      setAuthMode('login')
      setNotice('密码已重置，请使用新密码登录')
    } catch (requestError) {
      setError(getErrorMessage(requestError, '密码重置失败，请重试'))
    } finally {
      setResetBusy(false)
    }
  }

  return (
    <div
      className="copis-working-auth-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget && !busy && !resetBusy) onClose()
      }}
    >
      <section
        className="copis-working-auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copis-working-auth-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="copis-working-auth-top">
          <div className="copis-working-auth-brand">
            <span className="copis-working-auth-brand-icon" aria-hidden="true"><img src={CopisLogo} alt="" /></span>
            <span>Copis 账户</span>
          </div>
          {dismissible && (
            <button type="button" className="copis-working-auth-close" aria-label="关闭登录窗口" onClick={onClose} disabled={busy || resetBusy}>
              <X size={18} />
            </button>
          )}
        </div>

        <div className="copis-working-auth-switch" aria-label="认证方式">
          <button type="button" className={cn(authMode === 'login' && 'active')} onClick={() => switchAuthMode('login')}>
            <LogIn size={15} />
            登录
          </button>
          <button type="button" className={cn(authMode === 'register' && 'active')} onClick={() => switchAuthMode('register')}>
            <UserPlus size={15} />
            注册
          </button>
        </div>

        <header className="copis-working-auth-header">
          <h1 id="copis-working-auth-title">{authMode === 'login' ? '欢迎回来' : '创建 Copis 账户'}</h1>
          <p>{authMode === 'login' ? '登录后继续进入你的工作空间。' : '使用邮箱创建账户，登录后即可使用 Working Agent。'}</p>
        </header>

        <form className="copis-working-auth-form" onSubmit={(event) => void handleSubmit(event)}>
          <label className="copis-working-auth-field">
            <span>用户名或账号</span>
            <div className="copis-working-auth-input-wrap">
              <Mail size={16} aria-hidden="true" />
              <input
                ref={emailInputRef}
                type={authMode === 'login' ? 'text' : 'email'}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={authMode === 'login' ? '请输入用户名或账号' : '请输入邮箱地址'}
                autoComplete={authMode === 'login' ? 'username' : 'email'}
                disabled={busy}
                required
              />
            </div>
          </label>

          {authMode === 'register' && (
            <label className="copis-working-auth-field">
              <span>昵称 <small>选填</small></span>
              <input
                type="text"
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="请输入昵称"
                autoComplete="nickname"
                disabled={busy}
              />
            </label>
          )}

          <label className="copis-working-auth-field">
            <span>密码</span>
            <div className="copis-working-auth-input-wrap">
              <KeyRound size={16} aria-hidden="true" />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={authMode === 'login' ? '请输入密码' : '至少6位密码'}
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                minLength={authMode === 'register' ? 6 : undefined}
                disabled={busy}
                required
              />
            </div>
            {authMode === 'login' && (
              <button type="button" className="copis-working-auth-link" onClick={openForgotPassword} disabled={busy}>忘记密码？</button>
            )}
          </label>

          {authMode === 'register' && (
            <>
              <label className="copis-working-auth-field">
                <span>邀请码 <small>选填</small></span>
                <input
                  type="text"
                  value={invitationCode}
                  onChange={(event) => setInvitationCode(event.target.value)}
                  placeholder="有邀请码时可直接注册"
                  disabled={busy}
                />
              </label>
              {requiresVerificationCode && (
                <label className="copis-working-auth-field">
                  <span>邮箱验证码</span>
                  <div className="copis-working-auth-code-row">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={verificationCode}
                      onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
                      placeholder="4位验证码"
                      maxLength={4}
                      disabled={busy}
                      required
                    />
                    <button type="button" onClick={() => void handleSendCode('register')} disabled={busy || sendingCode || countdown > 0}>
                      {countdown > 0 ? `${countdown}s` : sendingCode ? '发送中' : '发送验证码'}
                    </button>
                  </div>
                </label>
              )}
            </>
          )}

          {authMode === 'login' && (
            <div className="copis-working-auth-persisted-note">
              <span className="copis-working-auth-check" aria-hidden="true">✓</span>
              登录状态和用户信息将安全保存在本机
            </div>
          )}

          {error && <p className="copis-working-auth-message error" role="alert">{error}</p>}
          {notice && <p className="copis-working-auth-message notice" role="status">{notice}</p>}

          <button type="submit" className="copis-working-auth-submit" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}
            {busy ? '处理中...' : authMode === 'login' ? '登录' : '创建账户'}
          </button>
        </form>

        <button type="button" className="copis-working-auth-footer-link" onClick={() => switchAuthMode(authMode === 'login' ? 'register' : 'login')} disabled={busy}>
          {authMode === 'login' ? '还没有账户？创建账户' : '已有账户？返回登录'}
        </button>
      </section>

      {forgotOpen && (
        <div className="copis-working-reset-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeForgotPassword()
        }}>
          <section className="copis-working-reset-modal" role="dialog" aria-modal="true" aria-labelledby="copis-working-reset-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="copis-working-auth-top">
              <div>
                <h2 id="copis-working-reset-title">找回密码</h2>
                <p>{forgotStep === 'email' ? '先确认你的注册邮箱' : forgotStep === 'code' ? '输入邮件里的4位验证码' : '设置一个新的登录密码'}</p>
              </div>
              <button type="button" className="copis-working-auth-close" aria-label="关闭找回密码" onClick={closeForgotPassword} disabled={resetBusy}><X size={18} /></button>
            </div>
            <div className="copis-working-reset-steps" aria-label="找回密码进度">
              {(['email', 'code', 'password'] as ForgotPasswordStep[]).map((step, index) => <span key={step} className={forgotStep === step ? 'active' : ''}>{index + 1}</span>)}
            </div>

            {forgotStep === 'email' && (
              <div className="copis-working-reset-body">
                <label className="copis-working-auth-field">
                  <span>邮箱地址</span>
                  <input type="email" value={forgotEmail} onChange={(event) => setForgotEmail(event.target.value)} placeholder="请输入注册邮箱" autoFocus disabled={resetBusy} />
                </label>
                <button type="button" className="copis-working-auth-submit" onClick={() => void handleSendCode('password_reset')} disabled={resetBusy || resetSendingCode || resetCountdown > 0}>
                  {resetCountdown > 0 ? `${resetCountdown}s 后可重发` : resetSendingCode ? '发送中...' : '发送验证码'}
                </button>
              </div>
            )}
            {forgotStep === 'code' && (
              <div className="copis-working-reset-body">
                <label className="copis-working-auth-field">
                  <span>邮箱验证码</span>
                  <input type="text" inputMode="numeric" value={forgotCode} onChange={(event) => setForgotCode(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4位验证码" maxLength={4} disabled={resetBusy} autoFocus />
                </label>
                <div className="copis-working-reset-actions">
                  <button type="button" className="copis-working-auth-secondary" onClick={() => setForgotStep('email')} disabled={resetBusy}>更换邮箱</button>
                  <button type="button" className="copis-working-auth-submit" onClick={() => void handleVerifyResetCode()} disabled={resetBusy}>{resetBusy ? '验证中...' : '验证验证码'}</button>
                </div>
              </div>
            )}
            {forgotStep === 'password' && (
              <div className="copis-working-reset-body">
                <label className="copis-working-auth-field">
                  <span>新密码</span>
                  <input type="password" value={forgotPassword} onChange={(event) => setForgotPassword(event.target.value)} placeholder="至少6位" minLength={6} disabled={resetBusy} autoFocus />
                </label>
                <label className="copis-working-auth-field">
                  <span>确认新密码</span>
                  <input type="password" value={forgotConfirmPassword} onChange={(event) => setForgotConfirmPassword(event.target.value)} placeholder="再次输入新密码" disabled={resetBusy} />
                </label>
                <button type="button" className="copis-working-auth-submit" onClick={() => void handleResetPassword()} disabled={resetBusy}>{resetBusy ? '重置中...' : '重置密码'}</button>
              </div>
            )}
            {error && <p className="copis-working-auth-message error" role="alert">{error}</p>}
          </section>
        </div>
      )}
    </div>
  )
}
