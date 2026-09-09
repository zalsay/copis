/**
 * ProxySettingsCard — 网络代理设置卡片组件
 *
 * 提供全局网络代理配置，支持开启/关闭代理、系统代理自动检测与手动代理地址配置。
 * 状态持久化到 ~/.copis/proxy-settings.json，并通过 Jotai atoms 与主进程同步。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import {
  CheckCircle2,
  Globe,
  Loader2,
  RefreshCw,
  Save,
  Server,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import type { ProxyConfig, ProxyMode } from '@copis/shared'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  detectingSystemProxyAtom,
  detectSystemProxyAtom,
  loadProxyConfigAtom,
  proxyConfigAtom,
  savingProxyConfigAtom,
  systemProxyDetectResultAtom,
  updateProxyConfigAtom,
} from '@/atoms/proxy-atoms'

interface ProxySettingsCardProps {
  onNotice?: (message: string) => void
  className?: string
}

export function ProxySettingsCard({
  onNotice,
  className,
}: ProxySettingsCardProps): React.ReactElement {
  const proxyConfig = useAtomValue(proxyConfigAtom)
  const systemDetectResult = useAtomValue(systemProxyDetectResultAtom)
  const detectingSystem = useAtomValue(detectingSystemProxyAtom)
  const saving = useAtomValue(savingProxyConfigAtom)

  const loadProxyConfig = useSetAtom(loadProxyConfigAtom)
  const updateProxyConfig = useSetAtom(updateProxyConfigAtom)
  const detectSystemProxy = useSetAtom(detectSystemProxyAtom)

  // 本地表单状态草稿
  const [enabled, setEnabled] = React.useState(false)
  const [mode, setMode] = React.useState<ProxyMode>('system')
  const [manualUrl, setManualUrl] = React.useState('')
  const [initialLoaded, setInitialLoaded] = React.useState(false)

  // 初始化加载配置
  React.useEffect(() => {
    let disposed = false
    void loadProxyConfig().then((cfg) => {
      if (disposed || !cfg) return
      setEnabled(cfg.enabled)
      setMode(cfg.mode)
      setManualUrl(cfg.manualUrl || '')
      setInitialLoaded(true)
    })
    return () => {
      disposed = true
    }
  }, [loadProxyConfig])

  // 当外部配置更新时同步本地状态
  React.useEffect(() => {
    if (proxyConfig && initialLoaded) {
      setEnabled(proxyConfig.enabled)
      setMode(proxyConfig.mode)
      setManualUrl(proxyConfig.manualUrl || '')
    }
  }, [proxyConfig, initialLoaded])

  const notify = React.useCallback(
    (msg: string) => {
      if (onNotice) {
        onNotice(msg)
      } else {
        toast.info(msg)
      }
    },
    [onNotice]
  )

  // 保存代理设置
  const handleSave = async (override?: Partial<ProxyConfig>): Promise<void> => {
    const nextConfig: ProxyConfig = {
      enabled: override?.enabled ?? enabled,
      mode: override?.mode ?? mode,
      manualUrl: (override?.manualUrl ?? manualUrl).trim(),
    }

    // 手动模式下基础 URL 格式校验提示
    if (nextConfig.enabled && nextConfig.mode === 'manual' && nextConfig.manualUrl) {
      if (!/^https?:\/\/.+/i.test(nextConfig.manualUrl)) {
        const warning = '代理地址请以 http:// 或 https:// 开头'
        toast.warning(warning)
        onNotice?.(warning)
      }
    }

    try {
      await updateProxyConfig(nextConfig)
      const successMsg = nextConfig.enabled ? '自定义模型代理已保存并生效' : '已关闭自定义模型代理（保持直连）'
      toast.success(successMsg)
      onNotice?.(successMsg)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : '保存代理配置失败'
      toast.error(errorMsg)
      onNotice?.(errorMsg)
    }
  }

  // 切换总开关
  const handleToggleEnabled = (nextChecked: boolean): void => {
    setEnabled(nextChecked)
    void handleSave({ enabled: nextChecked })
  }

  // 切换代理模式
  const handleModeChange = (nextMode: ProxyMode): void => {
    setMode(nextMode)
    void handleSave({ mode: nextMode })
    if (nextMode === 'system' && !systemDetectResult) {
      void handleDetectSystem()
    }
  }

  // 检测系统代理
  const handleDetectSystem = async (): Promise<void> => {
    const result = await detectSystemProxy()
    if (result.success && result.proxyUrl) {
      notify(`检测到系统代理: ${result.proxyUrl}`)
    } else {
      notify(result.message || '当前系统未配置网络代理')
    }
  }

  return (
    <section className={cn('rounded-lg border bg-card p-4 shadow-sm space-y-4', className)}>
      {/* 卡片头部：标题与主开关 */}
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary shrink-0">
            <Globe aria-hidden="true" className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">自定义模型网络代理</h3>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {enabled ? (mode === 'system' ? '系统代理 (自定义模型)' : '手动代理 (自定义模型)') : '已关闭 (直连)'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              仅对第三方自定义模型 API 请求及连通性测试生效，官方内置模型与其他网络通信保持直连。
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground hidden sm:inline">
            {enabled ? '已启用代理' : '启用代理'}
          </span>
          <Switch
            checked={enabled}
            onCheckedChange={handleToggleEnabled}
            disabled={saving}
            aria-label="启用自定义模型网络代理"
          />
        </div>
      </div>

      {/* 启用代理后的详细配置区域 */}
      {enabled && (
        <div className="space-y-4 pt-1">
          {/* 模式选择 */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-foreground/80">代理模式</span>
            <div className="inline-flex w-full sm:w-auto rounded-lg bg-muted p-1 gap-1">
              <button
                type="button"
                onClick={() => handleModeChange('system')}
                className={cn(
                  'flex-1 sm:flex-initial px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                  mode === 'system'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                系统代理 (自动检测)
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('manual')}
                className={cn(
                  'flex-1 sm:flex-initial px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                  mode === 'manual'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                手动配置
              </button>
            </div>
          </div>

          {/* 系统代理模式下的展示与检测 */}
          {mode === 'system' && (
            <div className="rounded-md border border-muted bg-muted/30 p-3 space-y-2.5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium text-foreground/90">
                    操作系统网络代理
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    自动读取 macOS、Windows 或 Linux 系统当前配置的 HTTP/HTTPS 代理。
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleDetectSystem()}
                  disabled={detectingSystem}
                  className="h-8 shrink-0 text-xs"
                >
                  {detectingSystem ? (
                    <Loader2 aria-hidden="true" className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw aria-hidden="true" className="mr-1.5 size-3.5" />
                  )}
                  {detectingSystem ? '正在检测...' : '检测系统代理'}
                </Button>
              </div>

              {/* 检测状态反馈 */}
              {systemDetectResult && (
                <div
                  className={cn(
                    'flex items-center gap-2 rounded px-2.5 py-1.5 text-xs',
                    systemDetectResult.success && systemDetectResult.proxyUrl
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {systemDetectResult.success && systemDetectResult.proxyUrl ? (
                    <CheckCircle2 className="size-3.5 shrink-0" />
                  ) : (
                    <XCircle className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-mono truncate">
                    {systemDetectResult.proxyUrl
                      ? `已检测到系统代理: ${systemDetectResult.proxyUrl}`
                      : systemDetectResult.message || '未检测到系统代理'}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* 手动配置模式下的地址输入 */}
          {mode === 'manual' && (
            <div className="space-y-3">
              <label className="min-w-0 space-y-1.5 block">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground/80">
                    代理服务器地址 (Proxy URL)
                  </span>
                </div>
                <div className="relative">
                  <Server className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input
                    type="text"
                    value={manualUrl}
                    onChange={(e) => setManualUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleSave()
                      }
                    }}
                    placeholder="http://127.0.0.1:7890"
                    className="pl-9 h-9 font-mono text-xs"
                  />
                </div>
                <span className="block text-[11px] text-muted-foreground">
                  支持 HTTP 或 HTTPS 代理协议，例如：http://127.0.0.1:7890 或 http://proxy.company.com:8080
                </span>
              </label>

              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleSave()}
                  disabled={saving}
                  className="h-8 text-xs"
                >
                  {saving ? (
                    <Loader2 aria-hidden="true" className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <Save aria-hidden="true" className="mr-1.5 size-3.5" />
                  )}
                  {saving ? '保存中...' : '保存代理配置'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
