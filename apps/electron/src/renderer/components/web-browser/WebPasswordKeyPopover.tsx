/**
 * 地址栏右侧钥匙图标快捷弹层 (WebPasswordKeyPopover)
 *
 * 展示当站已保存账号列表、一键填充及密码管理跳转。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { KeyRound, Settings, User, Check, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { WebTabState } from '@copis/shared'
import {
  activeTabPasswordPromptAtom,
  activeTabSavedLoginsAtom,
  resolvePasswordPromptAtom,
} from '@/atoms/web-password-atoms'
import {
  workingSettingsOpenAtom,
  workingSettingsSectionAtom,
} from '@/atoms/working-atoms'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface WebPasswordKeyPopoverProps {
  activeTab: WebTabState
}

export function WebPasswordKeyPopover({ activeTab }: WebPasswordKeyPopoverProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false)
  const savedLogins = useAtomValue(activeTabSavedLoginsAtom)
  const activePrompt = useAtomValue(activeTabPasswordPromptAtom)
  const resolvePrompt = useSetAtom(resolvePasswordPromptAtom)
  const setWorkingSettingsOpen = useSetAtom(workingSettingsOpenAtom)
  const setWorkingSettingsSection = useSetAtom(workingSettingsSectionAtom)
  const [fillingId, setFillingId] = React.useState<string | null>(null)

  const hasItems = savedLogins.length > 0 || Boolean(activePrompt)
  const originDisplay = React.useMemo(() => {
    try {
      return new URL(activeTab.url).hostname
    } catch {
      return activeTab.url
    }
  }, [activeTab.url])

  const handleFill = async (entryId: string, username: string): Promise<void> => {
    setFillingId(entryId)
    try {
      const ok = await window.electronAPI.webPasswords.fillCredentials(activeTab.id, entryId)
      if (ok) {
        toast.success(`已自动填充账号「${username}」`)
        setOpen(false)
      } else {
        toast.error('未在页面上找到匹配的输入框')
      }
    } catch {
      toast.error('填充失败')
    } finally {
      setFillingId(null)
    }
  }

  const handleOpenSettings = (): void => {
    setWorkingSettingsSection('passwords')
    setWorkingSettingsOpen(true)
    setOpen(false)
  }

  // 仅在当前网站有已存凭据或正在提示保存时，在地址栏展示钥匙图标
  if (!hasItems) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="查看保存的密码"
          className="size-7 shrink-0 rounded-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <KeyRound className="size-3.5 text-muted-foreground hover:text-foreground" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-72 p-0 shadow-lg border border-border/70 rounded-lg overflow-hidden bg-popover"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 py-2.5 bg-muted/40 border-b border-border/50">
          <div className="flex items-center gap-1.5 min-w-0">
            <KeyRound className="size-4 text-[var(--ui-primary)] shrink-0" style={{ color: 'var(--ui-primary)' }} />
            <span className="text-xs font-semibold text-foreground truncate">
              {originDisplay} 的密码
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground shrink-0">
            {savedLogins.length} 个账号
          </span>
        </div>

        {/* 若有待保存凭据，展示快速保存区域 */}
        {activePrompt ? (
          <div className="p-3 bg-[var(--ui-primary-background)]/35 border-b border-border/60 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <KeyRound className="size-3.5 shrink-0 text-[var(--ui-primary)]" style={{ color: 'var(--ui-primary)' }} />
              <span>{activePrompt.isUpdate ? '更新保存的密码？' : '保存此网站的密码？'}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              账号: <span className="text-foreground font-mono">{activePrompt.username}</span>
            </div>
            <div className="flex items-center gap-2 pt-0.5">
              <Button
                type="button"
                size="sm"
                className="h-6 px-2.5 text-xs font-medium border border-[var(--ui-primary)] bg-[var(--ui-primary)] text-[var(--ui-primary-foreground,#ffffff)] hover:opacity-90 active:scale-[0.98] transition-all shadow-xs cursor-pointer"
                style={{
                  backgroundColor: 'var(--ui-primary)',
                  borderColor: 'var(--ui-primary)',
                  color: 'var(--ui-primary-foreground, #ffffff)',
                }}
                onClick={async () => {
                  await resolvePrompt({
                    promptId: activePrompt.id,
                    action: 'save',
                    username: activePrompt.username,
                    passwordPlain: activePrompt.passwordPlain,
                  })
                  toast.success(activePrompt.isUpdate ? '已更新此网站的密码' : '已保存此网站的密码')
                  setOpen(false)
                }}
              >
                {activePrompt.isUpdate ? '更新' : '保存'}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={async () => {
                  await resolvePrompt({
                    promptId: activePrompt.id,
                    action: 'never',
                  })
                  toast.info('已将此网站加入从不保存密码列表')
                  setOpen(false)
                }}
              >
                永不保存
              </Button>
            </div>
          </div>
        ) : null}

        {/* 账号列表 */}
        <div className="max-h-60 overflow-y-auto p-2 space-y-1">
          {savedLogins.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              当前网站暂无保存的凭据
            </div>
          ) : (
            savedLogins.map((login) => (
              <div
                key={login.id}
                className="flex items-center justify-between rounded-md p-2 hover:bg-muted/50 transition-colors group"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                  <div className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground shrink-0">
                    <User className="size-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-foreground truncate">
                      {login.username}
                    </div>
                    <div className="text-[11px] font-mono text-muted-foreground">
                      ••••••••
                    </div>
                  </div>
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="h-6 px-2.5 text-[11px] shrink-0"
                  disabled={fillingId === login.id}
                  onClick={() => void handleFill(login.id, login.username)}
                >
                  {fillingId === login.id ? (
                    <Check className="size-3 text-emerald-500 animate-in zoom-in" />
                  ) : (
                    '填充'
                  )}
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-border/50 bg-muted/30 px-3.5 py-2">
          <button
            type="button"
            onClick={handleOpenSettings}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-[var(--ui-primary)] transition-colors"
          >
            <Settings className="size-3.5" />
            <span>管理密码</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
