/**
 * Copis 可独立安装、校验和更新的功能模块。
 *
 * Skill 只描述能力和调用规则，模块负责提供实际的 CLI 或其他运行时组件。
 */

export type FunctionalModuleName = 'officecli' | 'rust-http-api' | 'python-runtime' | (string & {})

export type FunctionalModulePlatform = 'darwin' | 'linux' | 'win32'

export type FunctionalModuleArchitecture = 'arm64' | 'x64'

export type FunctionalModuleFormat = 'binary' | 'tar.gz'

export interface FunctionalModuleManifestArtifact {
  version: string
  url: string
  sha256: string
  size: number
  format: FunctionalModuleFormat
  entrypoint: string
  required: boolean
}

export interface FunctionalModuleManifestPlatform {
  minClientVersion?: string
  modules: Record<string, FunctionalModuleManifestArtifact>
}

export interface FunctionalModuleClientUpdate {
  version: string
  url: string
  sha256: string
  size: number
  releaseNotes?: string
}

export interface FunctionalModuleClientConfig {
  minVersion?: string
  update?: FunctionalModuleClientUpdate
}

export interface FunctionalModuleManifest {
  schema: number
  channel: string
  client?: FunctionalModuleClientConfig
  platforms: Record<string, FunctionalModuleManifestPlatform>
}

export interface FunctionalModuleArtifact {
  name: FunctionalModuleName
  version: string
  platform: FunctionalModulePlatform
  arch: FunctionalModuleArchitecture
  url: string
  sha256: string
  size: number
  format: FunctionalModuleFormat
  entrypoint: string
  required: boolean
}

export interface FunctionalModuleStatus {
  name: FunctionalModuleName
  displayName: string
  installed: boolean
  version: string | null
  path: string | null
  availableVersion: string | null
  updateAvailable: boolean
  required: boolean
  error: string | null
}

export type FunctionalModuleProgressPhase =
  | 'manifest'
  | 'download'
  | 'verify'
  | 'install'
  | 'activate'
  | 'done'
  | 'error'

export interface FunctionalModuleProgressPayload {
  name: FunctionalModuleName
  phase: FunctionalModuleProgressPhase
  detail: string
  progress: number
  downloadedBytes?: number
  totalBytes?: number
  version?: string
}

export type FunctionalModuleStartupProgressPhase =
  | 'checking'
  | 'modules'
  | 'health'
  | 'ready'
  | 'error'

export interface FunctionalModuleStartupProgressPayload {
  phase: FunctionalModuleStartupProgressPhase
  detail: string
  progress: number
  activeModule?: FunctionalModuleName
  downloadedBytes?: number
  totalBytes?: number
  error?: string
}

export interface FunctionalModuleInstallInput {
  name: FunctionalModuleName
  force?: boolean
}

export const FUNCTIONAL_MODULE_IPC_CHANNELS = {
  LIST: 'functional-module:list',
  CHECK: 'functional-module:check',
  INSTALL: 'functional-module:install',
  PROGRESS: 'functional-module:progress',
  ENSURE_REQUIRED: 'functional-module:ensure-required',
  STARTUP_PROGRESS: 'functional-module:startup-progress',
} as const
