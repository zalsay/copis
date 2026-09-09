/**
 * 密码管理设置面板 (PasswordManagerSettings)
 *
 * 提供浏览器账号密码管理、显隐解密、单条复制、删除以及从不保存密码黑名单管理。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  Copy,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  allWebPasswordsAtom,
  disabledOriginsAtom,
  loadAllPasswordsAtom,
  loadPasswordSettingsAtom,
  passwordManagerLoadingAtom,
  passwordSearchQueryAtom,
  removeDisabledOriginAtom,
  removePasswordAtom,
  updatePasswordSettingsAtom,
  webPasswordSettingsAtom,
} from '@/atoms/web-password-atoms'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

export function PasswordManagerSettings(): React.ReactElement {
  const allPasswords = useAtomValue(allWebPasswordsAtom)
  const disabledOrigins = useAtomValue(disabledOriginsAtom)
  const settings = useAtomValue(webPasswordSettingsAtom)
  const loading = useAtomValue(passwordManagerLoadingAtom)
  const [searchQuery, setSearchQuery] = useAtom(passwordSearchQueryAtom)

  const loadAllPasswords = useSetAtom(loadAllPasswordsAtom)
  const loadPasswordSettings = useSetAtom(loadPasswordSettingsAtom)
  const updateSettings = useSetAtom(updatePasswordSettingsAtom)
  const removePassword = useSetAtom(removePasswordAtom)
  const removeDisabledOrigin = useSetAtom(removeDisabledOriginAtom)

  // 展开明文密码状态记录（按条目 ID 映射）
  const [revealedPasswords, setRevealedPasswords] = React.useState<Record<string, string>>({})
  const [revealingIds, setRevealingIds] = React.useState<Record<string, boolean>>({})

  React.useEffect(() => {
    void loadAllPasswords()
    void loadPasswordSettings()
  }, [loadAllPasswords, loadPasswordSettings])

  const handleSearch = (query: string): void => {
    setSearchQuery(query)
    void loadAllPasswords(query)
  }

  const handleToggleReveal = async (id: string): Promise<void> => {
    if (revealedPasswords[id]) {
      setRevealedPasswords((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      return
    }

    setRevealingIds((prev) => ({ ...prev, [id]: true }))
    try {
      const plain = await window.electronAPI.webPasswords.reveal(id)
      if (plain) {
        setRevealedPasswords((prev) => ({ ...prev, [id]: plain }))
      } else {
        toast.error('获取密码失败')
      }
    } catch {
      toast.error('解密失败')
    } finally {
      setRevealingIds((prev) => ({ ...prev, [id]: false }))
    }
  }

  const handleCopy = async (text: string, label: string): Promise<void> => {
    try {
      if (window.electronAPI?.writeClipboardText) {
        await window.electronAPI.writeClipboardText(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
      toast.success(`已复制${label}`)
    } catch {
      toast.error(`复制${label}失败`)
    }
  }

  const handleCopyPassword = async (id: string): Promise<void> => {
    try {
      let plain = revealedPasswords[id]
      if (!plain) {
        plain = (await window.electronAPI.webPasswords.reveal(id)) ?? ''
      }
      if (plain) {
        await handleCopy(plain, '密码')
      } else {
        toast.error('复制密码失败')
      }
    } catch {
      toast.error('复制密码失败')
    }
  }

  const handleDelete = async (id: string, username: string): Promise<void> => {
    try {
      const ok = await removePassword(id)
      if (ok) {
        toast.success(`已删除账号「${username}」`)
      }
    } catch {
      toast.error('删除账号失败')
    }
  }

  const handleRemoveDisabledOrigin = async (id: string, origin: string): Promise<void> => {
    try {
      const ok = await removeDisabledOrigin(id)
      if (ok) {
        toast.success(`已恢复「${origin}」的密码保存提示`)
      }
    } catch {
      toast.error('移除失败')
    }
  }

  return (
    <div className="space-y-6 max-w-4xl pb-10">
      {/* 1. 通用开关设置卡片 */}
      <div className="rounded-lg border border-border/60 bg-card p-4 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="text-sm font-medium text-foreground">提示保存密码</div>
            <div className="text-xs text-muted-foreground">
              在网页提交登录表单后，主动询问是否保存账号与密码。
            </div>
          </div>
          <Switch
            checked={settings.offerToSavePasswords}
            onCheckedChange={(checked) => void updateSettings({ offerToSavePasswords: checked })}
          />
        </div>

        <div className="border-t border-border/40 pt-4 flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="text-sm font-medium text-foreground">自动填充密码</div>
            <div className="text-xs text-muted-foreground">
              打开已保存密码的网站时，自动填入用户名和密码。
            </div>
          </div>
          <Switch
            checked={settings.autoFillPasswords}
            onCheckedChange={(checked) => void updateSettings({ autoFillPasswords: checked })}
          />
        </div>
      </div>

      {/* 2. 已保存账号列表卡片 */}
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-muted/20">
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-[var(--ui-primary)]" />
            <span className="text-sm font-medium text-foreground">已保存的密码</span>
            <span className="text-xs text-muted-foreground">({allPasswords.length})</span>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="搜索网站或用户名..."
              className="w-full h-8 pl-8 pr-3 text-xs rounded-md border border-border/60 bg-background text-foreground placeholder:text-muted-foreground outline-none focus:border-[var(--ui-primary)] transition-colors"
            />
          </div>
        </div>

        <div className="divide-y divide-border/40">
          {allPasswords.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              {loading ? '正在加载...' : searchQuery ? '未找到匹配的保存密码' : '暂无保存的密码'}
            </div>
          ) : (
            allPasswords.map((item) => {
              const isRevealed = Boolean(revealedPasswords[item.id])
              const displayPassword = isRevealed ? revealedPasswords[item.id] : item.passwordMasked
              const isBusy = Boolean(revealingIds[item.id])

              return (
                <div
                  key={item.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between p-3.5 gap-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                    <div className="flex size-8 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground shrink-0 mt-0.5 sm:mt-0">
                      <Globe className="size-4" />
                    </div>

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-foreground truncate" title={item.originUrl}>
                          {item.originUrl.replace(/^https?:\/\//, '')}
                        </span>
                        {item.useCount > 0 ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground">
                            使用 {item.useCount} 次
                          </span>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1 truncate max-w-[180px]" title={item.username}>
                          <User className="size-3 shrink-0" />
                          {item.username}
                        </span>
                        <span className="font-mono text-[11px] select-all">
                          {displayPassword}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 操作按钮区 */}
                  <div className="flex items-center gap-1 self-end sm:self-center shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      title={isRevealed ? '隐藏密码' : '显示密码'}
                      disabled={isBusy}
                      onClick={() => void handleToggleReveal(item.id)}
                    >
                      {isRevealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      title="复制用户名"
                      onClick={() => void handleCopy(item.username, '用户名')}
                    >
                      <Copy className="size-3.5" />
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 text-[var(--ui-primary)] hover:text-[var(--ui-primary)] hover:bg-[var(--ui-primary-background)] transition-colors"
                      style={{ color: 'var(--ui-primary)' }}
                      title="复制密码"
                      onClick={() => void handleCopyPassword(item.id)}
                    >
                      <KeyRound className="size-3.5" />
                    </Button>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 text-muted-foreground hover:text-destructive transition-colors"
                      title="删除此密码"
                      onClick={() => void handleDelete(item.id, item.username)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* 3. 从不保存密码的网站卡片 */}
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border/60 flex items-center justify-between bg-muted/20">
          <div className="flex items-center gap-2">
            <ShieldAlert className="size-4 text-amber-500" />
            <span className="text-sm font-medium text-foreground">从不保存密码的网站</span>
            <span className="text-xs text-muted-foreground">({disabledOrigins.length})</span>
          </div>
        </div>

        <div className="divide-y divide-border/40">
          {disabledOrigins.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              暂无被列入黑名单的网站
            </div>
          ) : (
            disabledOrigins.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-3.5 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldCheck className="size-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs text-foreground truncate font-mono">
                    {item.originUrl}
                  </span>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => void handleRemoveDisabledOrigin(item.id, item.originUrl)}
                >
                  <X className="size-3.5 mr-1" />
                  恢复提示
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
