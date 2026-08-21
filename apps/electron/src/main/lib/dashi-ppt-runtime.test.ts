import { describe, expect, mock, test } from 'bun:test'
import { join } from 'node:path'

mock.module('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

const {
  findChromiumHeadlessShellPath,
  REQUIRED_DASHI_PACKAGES,
  resolveDashiPptRuntime,
  validateDashiPackageContract,
} = await import('./dashi-ppt-runtime')

describe('Dashi PPT 运行时适配层', () => {
  const fakeWorkspaceRoot = '/mock/workspace'
  const fakeNodeExecutable = '/mock/runtime/bin/node'
  const fakePlaywrightCore = '/mock/runtime/playwright-core/index.js'
  const fakeHeadlessShell = '/mock/runtime/ms-playwright/chromium_headless_shell-1100/chrome-mac/headless_shell'
  const fakeNodeModules = '/mock/runtime/node_modules'
  const fakeSkillRoot = '/mock/default-skills/dashi-ppt'

  function createMockFileSystem(existingPaths: string[]): (path: string) => boolean {
    const set = new Set(existingPaths)
    return (path: string) => set.has(path)
  }

  const allValidPaths = [
    fakeWorkspaceRoot,
    fakeNodeExecutable,
    fakePlaywrightCore,
    fakeHeadlessShell,
    fakeNodeModules,
    fakeSkillRoot,
    join(fakeSkillRoot, 'project'),
    ...REQUIRED_DASHI_PACKAGES.map((pkg) => join(fakeNodeModules, pkg)),
  ]

  test('全套已有运行时就绪时，能够成功解析出完整 typed runtime', () => {
    const pathExists = createMockFileSystem(allValidPaths)

    const runtime = resolveDashiPptRuntime({
      workspaceRoot: fakeWorkspaceRoot,
      nodeExecutable: fakeNodeExecutable,
      playwrightCoreEntrypoint: fakePlaywrightCore,
      chromiumHeadlessShell: fakeHeadlessShell,
      nodeModulesRoot: fakeNodeModules,
      skillRoot: fakeSkillRoot,
      pathExists,
    })

    expect(runtime.nodeExecutable).toBe(fakeNodeExecutable)
    expect(runtime.playwrightCoreEntrypoint).toBe(fakePlaywrightCore)
    expect(runtime.chromiumHeadlessShell).toBe(fakeHeadlessShell)
    expect(runtime.nodeModulesRoot).toBe(fakeNodeModules)
    expect(runtime.skillProjectRoot).toBe(join(fakeSkillRoot, 'project'))
  })

  test('工作区路径不是绝对路径时抛出异常', () => {
    expect(() => {
      resolveDashiPptRuntime({
        workspaceRoot: 'relative/path',
      })
    }).toThrow('工作区根目录必须是绝对路径')
  })

  test('缺失 Node.js 运行时且未提供有效路径时抛出中文提示', () => {
    const pathExists = createMockFileSystem(allValidPaths.filter((p) => p !== fakeNodeExecutable))

    expect(() => {
      resolveDashiPptRuntime({
        workspaceRoot: fakeWorkspaceRoot,
        nodeExecutable: fakeNodeExecutable,
        playwrightCoreEntrypoint: fakePlaywrightCore,
        chromiumHeadlessShell: fakeHeadlessShell,
        nodeModulesRoot: fakeNodeModules,
        skillRoot: fakeSkillRoot,
        pathExists,
      })
    }).toThrow('未找到已激活的 Node.js 运行环境，请重新准备必要组件')
  })

  test('缺失 Playwright Core 时抛出中文提示', () => {
    const pathExists = createMockFileSystem(allValidPaths.filter((p) => p !== fakePlaywrightCore))

    expect(() => {
      resolveDashiPptRuntime({
        workspaceRoot: fakeWorkspaceRoot,
        nodeExecutable: fakeNodeExecutable,
        playwrightCoreEntrypoint: fakePlaywrightCore,
        chromiumHeadlessShell: fakeHeadlessShell,
        nodeModulesRoot: fakeNodeModules,
        skillRoot: fakeSkillRoot,
        pathExists,
      })
    }).toThrow('未找到已激活的浏览器自动化内核，请重新准备必要组件')
  })

  test('缺失 Chromium headless shell 时抛出明确提示且不 fallback 系统 Chrome', () => {
    const pathExists = createMockFileSystem(allValidPaths.filter((p) => p !== fakeHeadlessShell))

    expect(() => {
      resolveDashiPptRuntime({
        workspaceRoot: fakeWorkspaceRoot,
        nodeExecutable: fakeNodeExecutable,
        playwrightCoreEntrypoint: fakePlaywrightCore,
        chromiumHeadlessShell: '/nonexistent/headless_shell',
        nodeModulesRoot: fakeNodeModules,
        skillRoot: fakeSkillRoot,
        pathExists,
      })
    }).toThrow('未找到已准备的 Chromium headless shell，请重新准备浏览器运行时')
  })

  test('缺少必要依赖包时能够精确定位缺失的包名', () => {
    const missingPkg = 'pptxgenjs'
    const withoutPptxgen = allValidPaths.filter((p) => p !== join(fakeNodeModules, missingPkg))
    const pathExists = createMockFileSystem(withoutPptxgen)

    expect(() => {
      validateDashiPackageContract(fakeNodeModules, pathExists)
    }).toThrow(`缺少必要运行时依赖包: ${missingPkg}`)

    expect(() => {
      resolveDashiPptRuntime({
        workspaceRoot: fakeWorkspaceRoot,
        nodeExecutable: fakeNodeExecutable,
        playwrightCoreEntrypoint: fakePlaywrightCore,
        chromiumHeadlessShell: fakeHeadlessShell,
        nodeModulesRoot: fakeNodeModules,
        skillRoot: fakeSkillRoot,
        pathExists,
      })
    }).toThrow(`缺少必要运行时依赖包: ${missingPkg}`)
  })

  test('Windows 与 Linux 平台的 Chromium headless shell 可正确解析路径规范', () => {
    const winShell = 'C:\\ms-playwright\\chromium_headless_shell-1100\\chrome-win\\headless_shell.exe'
    const pathExistsWin = (path: string) => path === winShell

    const resolvedWin = findChromiumHeadlessShellPath(winShell, pathExistsWin, 'win32')
    expect(resolvedWin).toBe(winShell)
  })
})
