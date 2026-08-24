import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { app } from 'electron'
import { getFunctionalModulesDir } from './config-paths'
import { getFunctionalModulePath } from './functional-module-manager'

const require = createRequire(__filename)

export interface PlaywrightCoreRuntimeOptions {
  isPackaged?: boolean
  modulesRoot?: string
  activeEntrypoint?: string
  repositoryEntrypoint?: string
  /** 测试时覆盖随应用打包的 Playwright 入口。 */
  bundledEntrypoint?: string
}

/** 解析主进程使用的 Playwright Core 入口；安装位置不通过 IPC 或脚本内容暴露。 */
export function resolvePlaywrightCoreEntrypoint(
  options: PlaywrightCoreRuntimeOptions = {},
): string {
  const packaged = options.isPackaged ?? app.isPackaged
  if (!packaged) {
    return options.repositoryEntrypoint ?? require.resolve('playwright-core', { paths: [process.cwd()] })
  }

  const entrypoint = options.activeEntrypoint
    ?? getFunctionalModulePath('playwright-core', options.modulesRoot ?? getFunctionalModulesDir())
  if (entrypoint && isAbsolute(entrypoint)) return entrypoint

  const bundledEntrypoint = options.bundledEntrypoint ?? resolveBundledPlaywrightCoreEntrypoint()
  if (bundledEntrypoint && isAbsolute(bundledEntrypoint)) return bundledEntrypoint

  throw new Error('未找到已激活的浏览器自动化内核，请重新准备必要组件')
}

function resolveBundledPlaywrightCoreEntrypoint(): string | undefined {
  try {
    return require.resolve('playwright-core')
  } catch {
    return undefined
  }
}
