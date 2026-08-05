import type {
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
    displayName: 'Rust HTTP API',
    description: 'Copis 本地业务 API，完成 health 后才能进入主界面',
  },
  {
    name: 'officecli',
    displayName: 'OfficeCLI',
    description: '统一处理 Word、Excel 和 PowerPoint 文档',
  },
]

export type StartupGateAction = 'retry'

export function getStartupPhaseLabel(progress: Pick<FunctionalModuleStartupProgressPayload, 'phase' | 'progress'>): string {
  if (progress.phase === 'health' || progress.progress >= 0.95) return '正在检查本地 API'
  if (progress.phase === 'checking') return '正在检查功能模块'
  if (progress.phase === 'ready') return '所有功能模块已就绪'
  if (progress.phase === 'error') return '功能模块更新失败'
  return '正在准备功能模块'
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
