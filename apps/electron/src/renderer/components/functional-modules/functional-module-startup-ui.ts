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
]

export type StartupGateAction = 'retry'

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

export function getStartupErrorLabel(_error?: string | null): string {
  return '必要组件暂未准备完成，请重试'
}

export function getStartupModuleRows(): readonly StartupModuleRow[] {
  return STARTUP_MODULE_ROWS
}

export function getStartupModuleRowsForMode(isDevelopment: boolean): readonly StartupModuleRow[] {
  return isDevelopment ? [] : STARTUP_MODULE_ROWS
}

export function getStartupActions(phase: FunctionalModuleStartupProgressPayload['phase']): StartupGateAction[] {
  return phase === 'error' ? ['retry'] : []
}

export function formatStartupBytes(value: number | undefined): string {
  if (!value || value < 0) return ''
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
