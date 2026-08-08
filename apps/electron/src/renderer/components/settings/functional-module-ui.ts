import type {
  FunctionalModuleName,
  FunctionalModuleProgressPayload,
  FunctionalModuleStatus,
} from '@copis/shared'

export interface FunctionalModuleDefinition {
  name: FunctionalModuleName
  displayName: string
  description: string
  required: boolean
}

export const FUNCTIONAL_MODULE_DEFINITIONS: readonly FunctionalModuleDefinition[] = [
  {
    name: 'rust-http-api',
    displayName: '系统核心模块',
    description: 'Copis 的核心运行能力，负责本地服务和智能功能',
    required: true,
  },
  {
    name: 'officecli',
    displayName: 'Office 文档支持',
    description: '帮助 Copis 读取和处理 Word、Excel、PowerPoint 文档',
    required: true,
  },
]

export function createEmptyFunctionalModuleStatus(
  definition: FunctionalModuleDefinition,
): FunctionalModuleStatus {
  return {
    name: definition.name,
    displayName: definition.displayName,
    installed: false,
    version: null,
    path: null,
    availableVersion: null,
    updateAvailable: false,
    required: definition.required,
    error: null,
  }
}

export function getFunctionalModuleStateText(status: FunctionalModuleStatus): string {
  if (status.error) return '暂时无法准备，请重试'
  if (status.updateAvailable) {
    return `已准备好（v${status.version ?? '-'}），可更新至 v${status.availableVersion ?? '-'}`
  }
  if (status.installed) return `已准备好（v${status.version ?? '-'}）`
  return '尚未准备'
}

export function getFunctionalModuleProgressText(
  progress: Pick<FunctionalModuleProgressPayload, 'phase' | 'version'>,
): string {
  if (progress.phase === 'manifest') return '正在获取更新信息'
  if (progress.phase === 'download') return '正在下载更新'
  if (progress.phase === 'verify') return '正在验证文件'
  if (progress.phase === 'install') return '正在安装'
  if (progress.phase === 'activate') return '正在启用'
  if (progress.phase === 'done') return progress.version ? `已准备好（v${progress.version}）` : '已准备好'
  if (progress.phase === 'error') return '准备失败，请重试'
  return '正在准备'
}
