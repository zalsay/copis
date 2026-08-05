import type { FunctionalModuleName, FunctionalModuleStatus } from '@copis/shared'

export interface FunctionalModuleDefinition {
  name: FunctionalModuleName
  displayName: string
  description: string
  required: boolean
}

export const FUNCTIONAL_MODULE_DEFINITIONS: readonly FunctionalModuleDefinition[] = [
  {
    name: 'rust-http-api',
    displayName: 'Rust HTTP API',
    description: 'Copis 本地业务 API，由 Electron 负责启动和更新',
    required: true,
  },
  {
    name: 'officecli',
    displayName: 'OfficeCLI',
    description: '为 .docx、.xlsx、.pptx 提供统一的 Office 文档处理能力',
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
  if (status.error) return status.error
  if (status.updateAvailable) {
    return `v${status.version ?? '-'} 已安装，可更新到 v${status.availableVersion ?? '-'}`
  }
  if (status.installed) return `v${status.version ?? '-'} 已安装`
  return '未安装'
}
