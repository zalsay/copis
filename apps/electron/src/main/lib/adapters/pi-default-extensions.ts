/**
 * Copis 默认内置的 Pi 扩展。
 *
 * 通过 DefaultResourceLoader 的 additionalExtensionPaths 注入，让每个 Pi SDK
 * 会话默认都拥有这些扩展能力（如联网搜索、网页抓取），无需用户手动 pi install。
 *
 * 路径解析策略：
 * - 打包模式：Electron 主进程注入 COPIS_PI_EXTENSIONS_DIR，指向
 *   process.resourcesPath/pi-extensions（真实磁盘目录，worker 可直接读取）；
 * - 开发模式：从 worker bundle 位置向上解析 node_modules 中的扩展包。
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/** 默认内置的 Pi 扩展包名（包内 pi.extensions 声明扩展入口）。 */
const DEFAULT_PI_EXTENSIONS = ['pi-web-access'] as const

function resolvePiExtensionEntry(packageName: string): string | undefined {
  // 1. 打包模式：主进程注入的扩展目录。
  const packagedRoot = process.env.COPIS_PI_EXTENSIONS_DIR
  if (packagedRoot) {
    const candidate = join(packagedRoot, 'node_modules', packageName, 'index.ts')
    if (existsSync(candidate)) return candidate
  }

  // 2. 开发模式：node_modules 解析（pi-web-access 无 exports 字段，可深路径解析）。
  try {
    const require = createRequire(import.meta.url)
    return require.resolve(`${packageName}/index.ts`)
  } catch {
    return undefined
  }
}

/** 解析所有默认扩展的入口路径；缺失时跳过并告警，不阻断会话启动。 */
export function resolveDefaultPiExtensionEntries(): string[] {
  const entries: string[] = []
  for (const packageName of DEFAULT_PI_EXTENSIONS) {
    const entry = resolvePiExtensionEntry(packageName)
    if (entry) {
      entries.push(entry)
    } else {
      console.warn(`[Pi 扩展] 默认扩展 ${packageName} 未找到，已跳过（会话不受影响）`)
    }
  }
  return entries
}
