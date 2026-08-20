import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { AppInfo } from '@copis/shared'
import { checkForUpdates, downloadUpdate, updaterAvailableAtom, updateStatusAtom, type UpdateStatus } from '@/atoms/updater'
import { CopisAppLogo } from '@/lib/model-logo'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from './primitives'
import { FunctionalModulesCard } from './FunctionalModulesCard'

function getAppUpdateStatusText(status: UpdateStatus, appInfo: AppInfo | null): string {
  switch (status.status) {
    case 'checking':
      return '正在检查更新'
    case 'available':
      return `发现新版本 v${status.version}，点击下载更新`
    case 'downloading':
      return `正在下载 v${status.version}`
    case 'downloaded':
      return `v${status.version} 已下载，可在空闲时安装`
    case 'not-available':
      return appInfo ? `当前已是 v${appInfo.version}，没有可用更新` : '当前没有可用更新'
    case 'error':
      return status.error || '检查更新失败，请稍后重试'
    default:
      return '尚未检查更新'
  }
}

export function AboutUpdatesSettings(): React.ReactElement {
  const [appInfo, setAppInfo] = React.useState<AppInfo | null>(null)
  const updateStatus = useAtomValue(updateStatusAtom)
  const updaterAvailable = useAtomValue(updaterAvailableAtom)

  React.useEffect(() => {
    let active = true
    window.electronAPI.getAppInfo()
      .then((info) => {
        if (active) setAppInfo(info)
      })
      .catch(() => {
        if (active) setAppInfo({ version: '-', packaged: false })
      })
    return () => {
      active = false
    }
  }, [])

  const onlineUpdateAvailable = updaterAvailable && appInfo?.packaged === true
  const isDownloading = updateStatus.status === 'downloading'
  const progressPercent = isDownloading
    ? Math.round(Math.min(100, Math.max(0, updateStatus.progress?.percent ?? 0)))
    : 0

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Copis 桌面端"
        description="查看当前主程序版本，并检查、下载和安装应用更新。"
      >
        <SettingsCard>
          <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <img src={CopisAppLogo} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium">Copis 桌面端</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  当前版本 <span className="font-mono tabular-nums">{appInfo ? `v${appInfo.version}` : '正在读取'}</span>
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {onlineUpdateAvailable ? (
                <>
                  {updateStatus.status === 'available' && (
                    <Button size="sm" className="h-8 text-xs" onClick={() => void downloadUpdate()}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      下载更新
                    </Button>
                  )}
                  {updateStatus.status === 'downloaded' && (
                    <Button size="sm" className="h-8 text-xs" onClick={() => void window.electronAPI.updater?.installWhenIdle()}>
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                      空闲时安装
                    </Button>
                  )}
                  {updateStatus.status !== 'available' && updateStatus.status !== 'downloaded' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => void checkForUpdates()}
                      disabled={updateStatus.status === 'checking' || updateStatus.status === 'downloading'}
                    >
                      {updateStatus.status === 'checking' ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : updateStatus.status === 'downloading' ? (
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {updateStatus.status === 'checking' ? '检查中' : updateStatus.status === 'downloading' ? '下载中' : '检查更新'}
                    </Button>
                  )}
                </>
              ) : (
                <Button variant="outline" size="sm" className="h-8 text-xs" disabled>
                  开发版不支持在线更新
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => void window.electronAPI.openExternal('https://copis.meetlife.com.cn')}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                查看发布页
              </Button>
            </div>
          </div>
          <div className="border-t p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">{getAppUpdateStatusText(updateStatus, appInfo)}</p>
              {isDownloading && (
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{progressPercent}%</span>
              )}
            </div>
            {isDownloading && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="本地能力"
        description="Copis 独立安装和更新的运行时模块，可按模块检查更新、下载或安装。"
      >
        <FunctionalModulesCard />
      </SettingsSection>

    </div>
  )
}
