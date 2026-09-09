/**
 * 网页密码保存 / 更新提示气泡条
 *
 * 参考 Google Chrome 密码提示条设计，展示在内嵌浏览器工具栏下方。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Eye, EyeOff, KeyRound, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import type { WebPasswordSavePrompt } from '@copis/shared'
import { resolvePasswordPromptAtom } from '@/atoms/web-password-atoms'
import { Button } from '@/components/ui/button'

interface WebPasswordPromptBannerProps {
  prompt: WebPasswordSavePrompt
}

export function WebPasswordPromptBanner({ prompt }: WebPasswordPromptBannerProps): React.ReactElement {
  const resolvePrompt = useSetAtom(resolvePasswordPromptAtom)
  const [username, setUsername] = React.useState(prompt.username)
  const [password, setPassword] = React.useState(prompt.passwordPlain)
  const [showPassword, setShowPassword] = React.useState(false)
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  // 当提示切换时重置状态
  React.useEffect(() => {
    setUsername(prompt.username)
    setPassword(prompt.passwordPlain)
    setShowPassword(false)
  }, [prompt.id, prompt.username, prompt.passwordPlain])

  const handleSave = async (): Promise<void> => {
    setIsSubmitting(true)
    try {
      await resolvePrompt({
        promptId: prompt.id,
        action: 'save',
        username,
        passwordPlain: password,
      })
      toast.success(prompt.isUpdate ? '已更新此网站的密码' : '已保存此网站的密码')
    } catch {
      toast.error('保存密码失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleNever = async (): Promise<void> => {
    setIsSubmitting(true)
    try {
      await resolvePrompt({
        promptId: prompt.id,
        action: 'never',
      })
      toast.info('已将此网站加入从不保存密码列表')
    } catch {
      toast.error('操作失败')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDismiss = async (): Promise<void> => {
    await resolvePrompt({
      promptId: prompt.id,
      action: 'dismiss',
    })
  }

  return (
    <div className="relative flex items-center justify-between border-b border-border/70 bg-background/95 px-4 py-2 shadow-xs backdrop-blur-sm animate-in fade-in slide-in-from-top-1 duration-200">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <KeyRound className="size-4 shrink-0 text-[var(--ui-primary)]" style={{ color: 'var(--ui-primary)' }} />
          <span>{prompt.isUpdate ? '更新保存的密码？' : '保存此网站的密码？'}</span>
          <span className="max-w-[200px] truncate text-muted-foreground" title={prompt.originUrl}>
            ({prompt.originUrl.replace(/^https?:\/\//, '')})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* 用户名 */}
          <div className="flex h-7 items-center rounded border border-border/60 bg-muted/30 px-2 text-xs">
            <span className="mr-1 text-muted-foreground select-none">账号:</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-28 bg-transparent text-foreground outline-none"
              placeholder="用户名/邮箱"
            />
          </div>

          {/* 密码 */}
          <div className="flex h-7 items-center rounded border border-border/60 bg-muted/30 px-2 text-xs">
            <span className="mr-1 text-muted-foreground select-none">密码:</span>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-28 bg-transparent text-foreground outline-none font-mono"
              placeholder="密码"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPassword(!showPassword)}
              className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
              title={showPassword ? '隐藏密码' : '显示密码'}
            >
              {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-7 px-3 text-xs font-medium border border-[var(--ui-primary)] bg-[var(--ui-primary)] text-[var(--ui-primary-foreground,#ffffff)] hover:opacity-90 active:scale-[0.98] transition-all shadow-xs cursor-pointer"
          style={{
            backgroundColor: 'var(--ui-primary)',
            borderColor: 'var(--ui-primary)',
            color: 'var(--ui-primary-foreground, #ffffff)',
          }}
          disabled={isSubmitting || !username.trim() || !password}
          onClick={() => void handleSave()}
        >
          {prompt.isUpdate ? '更新' : '保存'}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={isSubmitting}
          onClick={() => void handleNever()}
          title="从不为此网站保存密码"
        >
          <ShieldAlert className="size-3.5 mr-1" />
          永不保存
        </Button>

        <button
          type="button"
          aria-label="暂不保存"
          onClick={() => void handleDismiss()}
          className="ml-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
