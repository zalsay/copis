/**
 * 自动更新相关类型定义
 *
 * 检测新版本 → 自动下载 → 用户选择立即或空闲时重启安装
 */

/** Rust API 返回的主程序更新信息 */
export interface AppUpdateInfo {
  available: boolean
  version?: string
  latestVersion?: string
  url?: string
  sha256?: string
  size?: number
  releaseNotes?: string
}

/** 更新状态 */
export type UpdateStatus =
  | { status: 'idle' }
  | { status: 'checking' }
  | {
      status: 'available'
      version: string
      latestVersion?: string
      releaseNotes?: string
      downloadUrl?: string
      fileSha256?: string
      fileSize?: number
    }
  | { status: 'downloading'; version: string; latestVersion?: string; progress: DownloadProgress }
  | { status: 'downloaded'; version: string; latestVersion?: string; filePath?: string }
  | { status: 'not-available'; version?: string; latestVersion?: string }
  | { status: 'error'; error: string; latestVersion?: string }

/** 下载进度 */
export interface DownloadProgress {
  /** 已下载百分比 0-100 */
  percent: number
  /** 已下载字节数 */
  transferred: number
  /** 总字节数 */
  total: number
  /** 下载速度（字节/秒） */
  bytesPerSecond: number
}

/** 更新 IPC 通道常量 */
export const UPDATER_IPC_CHANNELS = {
  CHECK_FOR_UPDATES: 'updater:check',
  DOWNLOAD: 'updater:download',
  GET_STATUS: 'updater:get-status',
  ON_STATUS_CHANGED: 'updater:status-changed',
  INSTALL_WHEN_IDLE: 'updater:install-when-idle',
  CANCEL_IDLE_INSTALL: 'updater:cancel-idle-install',
} as const
