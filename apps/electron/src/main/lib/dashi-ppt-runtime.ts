import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import { getDefaultSkillsDir, getFunctionalModulesDir } from './config-paths'
import { getFunctionalModulePath } from './functional-module-manager'
import { resolvePlaywrightCoreEntrypoint } from './playwright-core-runtime'

export function isAbsoluteForPlatform(targetPath: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(targetPath) : isAbsolute(targetPath)
}

export function resolveNodeRuntimeEntrypoint(): string {
  const entrypoint = getFunctionalModulePath('node-runtime')
  if (!entrypoint) throw new Error('未找到已激活的 Node.js 运行环境，请重新准备必要组件')
  return entrypoint
}

function getElectronApp(): { isPackaged: boolean } | undefined {
  try {
    const electron = require('electron')
    return electron.app
  } catch {
    return undefined
  }
}

export const REQUIRED_DASHI_PACKAGES = [
  'gsap',
  'html-to-image',
  'pptxgenjs',
  'react',
  'react-dom',
  'tsx',
  'esbuild',
  'pngjs',
  'playwright-core',
  'pdf-lib',
] as const

export type RequiredDashiPackage = (typeof REQUIRED_DASHI_PACKAGES)[number]

export interface DashiPptRuntime {
  nodeExecutable: string
  nodeModulesRoot: string
  playwrightCoreEntrypoint: string
  chromiumHeadlessShell: string
  skillProjectRoot: string
}

export interface ResolveDashiPptRuntimeOptions {
  workspaceRoot: string
  skillRoot?: string
  nodeExecutable?: string
  nodeModulesRoot?: string
  playwrightCoreEntrypoint?: string
  chromiumHeadlessShell?: string
  isPackaged?: boolean
  pathExists?: (path: string) => boolean
}

function getPathExists(options?: ResolveDashiPptRuntimeOptions): (path: string) => boolean {
  return options?.pathExists ?? existsSync
}

function isPackagedApp(options?: ResolveDashiPptRuntimeOptions): boolean {
  if (options?.isPackaged !== undefined) return options.isPackaged
  return getElectronApp()?.isPackaged ?? false
}

/** 查找已安装的 Chromium headless shell 可执行文件。 */
export function findChromiumHeadlessShellPath(
  customPath?: string,
  pathExists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  if (customPath) {
    if (!isAbsoluteForPlatform(customPath, platform) || !pathExists(customPath)) {
      throw new Error(`未找到已准备的 Chromium headless shell，请重新准备浏览器运行时: ${customPath}`)
    }
    return customPath
  }

  const envPath = process.env.COPIS_PLAYWRIGHT_HEADLESS_SHELL || process.env.PLAYWRIGHT_CHROMIUM_HEADLESS_SHELL
  if (envPath && isAbsoluteForPlatform(envPath, platform) && pathExists(envPath)) {
    return envPath
  }

  const relativeSubpath = platform === 'darwin'
    ? join('chrome-mac', 'headless_shell')
    : platform === 'win32'
      ? join('chrome-win', 'headless_shell.exe')
      : join('chrome-linux', 'headless_shell')

  const searchRoots: string[] = []
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    searchRoots.push(process.env.PLAYWRIGHT_BROWSERS_PATH)
  }

  const home = homedir()
  if (platform === 'darwin') {
    searchRoots.push(join(home, 'Library', 'Caches', 'ms-playwright'))
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    searchRoots.push(join(localAppData, 'ms-playwright'))
  } else {
    searchRoots.push(join(home, '.cache', 'ms-playwright'))
  }

  try {
    searchRoots.push(join(getFunctionalModulesDir(), 'playwright-browsers'))
  } catch {
    // 忽略无法解析 functional modules 目录的情况
  }

  for (const root of searchRoots) {
    if (!pathExists(root)) continue
    try {
      const entries = readdirSync(root, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('chromium_headless_shell-')) {
          const candidate = join(root, entry.name, relativeSubpath)
          if (pathExists(candidate)) {
            return candidate
          }
        }
      }
    } catch {
      // 忽略读取目录异常
    }
  }

  throw new Error('未找到已准备的 Chromium headless shell，请重新准备浏览器运行时')
}

/** 解析共享 node_modules 根目录。 */
export function resolveSharedNodeModulesRoot(
  customPath?: string,
  pathExists: (path: string) => boolean = existsSync,
  isPackaged = false,
): string {
  if (customPath) {
    if (!isAbsolute(customPath) || !pathExists(customPath)) {
      throw new Error(`指定的 node_modules 目录无效: ${customPath}`)
    }
    return customPath
  }

  const envPath = process.env.COPIS_NODE_MODULES_ROOT
  if (envPath && isAbsolute(envPath) && pathExists(envPath)) {
    return envPath
  }

  const candidates: string[] = []
  if (!isPackaged) {
    candidates.push(
      resolve(__dirname, '../../../../node_modules'),
      resolve(__dirname, '../../../node_modules'),
      join(process.cwd(), 'node_modules'),
      join(process.cwd(), 'apps/electron/node_modules'),
    )
  } else {
    try {
      if (process.resourcesPath) {
        candidates.push(
          join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
          join(process.resourcesPath, 'node_modules'),
        )
      }
    } catch {
      // 忽略 resourcesPath 异常
    }
    try {
      candidates.push(join(getFunctionalModulesDir(), 'node-runtime', 'node_modules'))
    } catch {
      // 忽略 functional modules 异常
    }
  }

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate
    }
  }

  throw new Error('未找到已激活的共享依赖模块目录 (node_modules)，请重新准备必要组件')
}

/** 解析 Dashi PPT Skill 项目根目录。 */
export function resolveDashiSkillProjectRoot(
  skillRoot?: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (skillRoot) {
    const projectDir = join(skillRoot, 'project')
    if (pathExists(projectDir)) return projectDir
    if (pathExists(skillRoot)) return skillRoot
    throw new Error(`未找到 Dashi PPT 项目根目录: ${skillRoot}`)
  }

  const envPath = process.env.COPIS_DASHI_PPT_PROJECT_ROOT
  if (envPath && isAbsolute(envPath) && pathExists(envPath)) {
    return envPath
  }

  const candidates = [
    join(getDefaultSkillsDir(), 'dashi-ppt', 'project'),
    resolve(__dirname, '../default-skills/dashi-ppt/project'),
    resolve(__dirname, '../../../default-skills/dashi-ppt/project'),
  ]

  try {
    if (process.resourcesPath) {
      candidates.push(join(process.resourcesPath, 'default-skills', 'dashi-ppt', 'project'))
    }
  } catch {
    // 忽略 resourcesPath 异常
  }

  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate
    }
  }

  throw new Error('未找到 Dashi PPT 项目根目录，请确保已正确同步 dashi-ppt 内置 Skill')
}

/** 校验共享 node_modules 中是否具备 Dashi PPT 所需的依赖契约。 */
export function validateDashiPackageContract(
  nodeModulesRoot: string,
  pathExists: (path: string) => boolean = existsSync,
): void {
  for (const pkg of REQUIRED_DASHI_PACKAGES) {
    const pkgDir = join(nodeModulesRoot, pkg)
    const pkgJson = join(pkgDir, 'package.json')
    if (!pathExists(pkgDir) && !pathExists(pkgJson)) {
      throw new Error(`缺少必要运行时依赖包: ${pkg}`)
    }
  }
}

/**
 * 组装并解析 Dashi PPT 运行时环境。
 * 组合已有的 Node.js、Playwright Core、共享 node_modules 与 Chromium headless shell，不新建功能模块。
 */
export function resolveDashiPptRuntime(
  options: ResolveDashiPptRuntimeOptions,
): DashiPptRuntime {
  if (!options.workspaceRoot || !isAbsolute(options.workspaceRoot)) {
    throw new Error('工作区根目录必须是绝对路径')
  }

  const pathExists = getPathExists(options)
  const isPackaged = isPackagedApp(options)

  // 1. 解析 Node.js 可执行文件
  let nodeExecutable: string
  if (options.nodeExecutable) {
    if (!isAbsolute(options.nodeExecutable) || !pathExists(options.nodeExecutable)) {
      throw new Error(`未找到已激活的 Node.js 运行环境，请重新准备必要组件: ${options.nodeExecutable}`)
    }
    nodeExecutable = options.nodeExecutable
  } else {
    try {
      nodeExecutable = resolveNodeRuntimeEntrypoint()
    } catch {
      throw new Error('未找到已激活的 Node.js 运行环境，请重新准备必要组件')
    }
  }

  // 2. 解析 Playwright Core 入口
  let playwrightCoreEntrypoint: string
  if (options.playwrightCoreEntrypoint) {
    if (!isAbsolute(options.playwrightCoreEntrypoint) || !pathExists(options.playwrightCoreEntrypoint)) {
      throw new Error(`未找到已激活的浏览器自动化内核，请重新准备必要组件: ${options.playwrightCoreEntrypoint}`)
    }
    playwrightCoreEntrypoint = options.playwrightCoreEntrypoint
  } else {
    try {
      playwrightCoreEntrypoint = resolvePlaywrightCoreEntrypoint({ isPackaged })
    } catch {
      throw new Error('未找到已激活的浏览器自动化内核，请重新准备必要组件')
    }
  }

  // 3. 解析 Chromium headless shell
  const chromiumHeadlessShell = findChromiumHeadlessShellPath(
    options.chromiumHeadlessShell,
    pathExists,
  )

  // 4. 解析共享 node_modules 根目录
  const nodeModulesRoot = resolveSharedNodeModulesRoot(
    options.nodeModulesRoot,
    pathExists,
    isPackaged,
  )

  // 5. 校验依赖契约
  validateDashiPackageContract(nodeModulesRoot, pathExists)

  // 6. 解析 Skill 项目源码根目录
  const skillProjectRoot = resolveDashiSkillProjectRoot(
    options.skillRoot,
    pathExists,
  )

  return {
    nodeExecutable,
    nodeModulesRoot,
    playwrightCoreEntrypoint,
    chromiumHeadlessShell,
    skillProjectRoot,
  }
}
