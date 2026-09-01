import type {
  FunctionalModuleProgressPayload,
  FunctionalModuleName,
  FunctionalModuleStartupProgressPayload,
} from '@copis/shared'

export interface StartupModuleRow {
  name: FunctionalModuleName
  displayName: string
  description: string
}

export const STARTUP_MODULE_ROWS: readonly StartupModuleRow[] = [
  {
    name: 'rust-http-api',
    displayName: '系统核心模块',
    description: 'Copis 的核心运行能力，负责本地服务和智能功能',
  },
  {
    name: 'officecli',
    displayName: 'Office 文档支持',
    description: '帮助 Copis 读取和处理 Word、Excel、PowerPoint 文档',
  },
  {
    name: 'alipay-bot',
    displayName: '支付宝智能体 CLI',
    description: '为默认项目提供支付宝付款能力',
  },
  {
    name: 'playwright-core',
    displayName: '浏览器自动化内核',
    description: '为 Browser Workflow 提供页面自动化能力',
  },
  {
    name: 'python-runtime',
    displayName: 'Python 3.12 运行环境',
    description: '为自动化任务和工作区工具提供稳定的 Python 运行环境',
  },
]

export type StartupGateAction = 'retry' | 'download_update'

export const COPIS_DOWNLOAD_URL = 'https://copis.meetlife.com.cn'

export interface StartupClientUpdateRequired {
  minClientVersion: string
}

export interface StartupClientUpdateDialog extends StartupClientUpdateRequired {
  title: string
  description: string
  actionLabel: string
}

const CLIENT_UPDATE_REQUIRED_PATTERN = /^Copis 版本过低，需要至少 v?([^\s]+)$/

export function parseStartupClientUpdateRequired(error?: string | null): StartupClientUpdateRequired | null {
  const match = error?.trim().match(CLIENT_UPDATE_REQUIRED_PATTERN)
  return match ? { minClientVersion: match[1]! } : null
}

export function isStartupClientUpdateRequired(error?: string | null): boolean {
  return parseStartupClientUpdateRequired(error) !== null
}

export function getStartupClientUpdateDialog(error?: string | null): StartupClientUpdateDialog | null {
  const clientUpdate = parseStartupClientUpdateRequired(error)
  if (!clientUpdate) return null
  return {
    ...clientUpdate,
    title: '需要更新 Copis',
    description: `必要组件要求 Copis v${clientUpdate.minClientVersion} 或更高版本。下载最新版本后重新打开应用。`,
    actionLabel: '下载最新版本',
  }
}

export function getStartupPhaseLabel(progress: Pick<FunctionalModuleStartupProgressPayload, 'phase' | 'progress'>): string {
  if (progress.phase === 'ready') return '本地服务运行正常'
  if (progress.phase === 'error') return '必要组件准备失败'
  if (progress.phase === 'health' || progress.progress >= 0.95) return '正在检查本地服务'
  if (progress.phase === 'checking') return '正在检查必要组件'
  return '正在准备必要组件'
}

/** 将主进程阶段详情转换成面向用户的简短提示，避免透传实现名称。 */
export function getStartupModuleDetail(
  progress: Pick<FunctionalModuleProgressPayload, 'phase' | 'version'> | undefined,
): string {
  if (!progress) return '正在准备'
  if (progress.phase === 'manifest') return '正在获取更新信息'
  if (progress.phase === 'download') return '正在下载更新'
  if (progress.phase === 'verify') return '正在验证文件'
  if (progress.phase === 'install') return '正在安装'
  if (progress.phase === 'activate') return '正在启用'
  if (progress.phase === 'done') return progress.version ? `已准备好（v${progress.version}）` : '已准备好'
  if (progress.phase === 'error') return '准备失败，请重试'
  return '正在准备'
}

export function getStartupErrorLabel(error?: string | null): string {
  const clientUpdate = parseStartupClientUpdateRequired(error)
  if (clientUpdate) {
    return `当前 Copis 版本过低，需要至少 v${clientUpdate.minClientVersion}，请下载最新版本`
  }
  return '必要组件暂未准备完成，请重试'
}

export function getStartupModuleRows(): readonly StartupModuleRow[] {
  return STARTUP_MODULE_ROWS
}

export function getStartupModuleRowsForMode(isDevelopment: boolean): readonly StartupModuleRow[] {
  return isDevelopment ? [] : STARTUP_MODULE_ROWS
}

export function getStartupActions(
  phase: FunctionalModuleStartupProgressPayload['phase'],
  error?: string | null,
): StartupGateAction[] {
  if (phase !== 'error') return []
  return isStartupClientUpdateRequired(error) ? ['download_update'] : ['retry']
}

export function formatStartupBytes(value: number | undefined): string {
  if (!value || value < 0) return ''
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
