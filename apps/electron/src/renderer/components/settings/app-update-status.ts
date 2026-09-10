import type { AppInfo } from '@copis/shared'
import type { UpdateStatus } from '../../atoms/updater'

export function getAppUpdateStatusText(status: UpdateStatus, appInfo: AppInfo | null): string {
  const latest = status.version || status.latestVersion
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
      if (!appInfo || appInfo.version === '-') return '当前平台暂无可用更新'
      // 不可下载也可能是平台缺包，不能据此认定远端版本已经安装。
      return latest === appInfo.version
        ? `当前已是最新版 v${appInfo.version}，没有可用更新`
        : `当前运行 v${appInfo.version}，当前平台暂无可用更新`
    case 'error':
      return status.error || '检查更新失败，请稍后重试'
    default:
      return '尚未检查更新'
  }
}
