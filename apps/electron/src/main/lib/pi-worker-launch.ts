import { existsSync } from 'node:fs'

export interface PiWorkerLaunch {
  kind: 'executable' | 'script'
  path: string
}

export interface PiWorkerRuntime {
  path: string
  useSystemRuntime: true
}

export interface ResolvePiWorkerLaunchOptions {
  isPackaged: boolean
  bundledCliPath?: string
  developmentCandidates: string[]
  exists?: (path: string) => boolean
}

export interface ResolvePiWorkerRuntimeOptions {
  isPackaged: boolean
  bunPath?: string
}

export function resolvePiWorkerLaunch(options: ResolvePiWorkerLaunchOptions): PiWorkerLaunch | undefined {
  const exists = options.exists ?? existsSync
  if (options.isPackaged) {
    const executablePath = options.bundledCliPath
    return executablePath && exists(executablePath)
      ? { kind: 'executable', path: executablePath }
      : undefined
  }

  const scriptPath = options.developmentCandidates.find((candidate) => exists(candidate))
  return scriptPath
    ? { kind: 'script', path: scriptPath }
    : undefined
}

/** 开发模式的 JS Worker 使用 Bun 执行，避免依赖未安装的托管 Node runtime。 */
export function resolvePiWorkerRuntime(
  options: ResolvePiWorkerRuntimeOptions,
): PiWorkerRuntime | undefined {
  if (options.isPackaged || !options.bunPath?.trim()) return undefined
  return {
    path: options.bunPath,
    useSystemRuntime: true,
  }
}
