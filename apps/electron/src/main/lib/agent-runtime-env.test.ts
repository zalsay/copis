import { describe, expect, test } from 'bun:test'
import type { GitBashStatus, RuntimeStatus, ShellEnvironmentStatus, WslStatus } from '@copis/shared'
import { buildAgentRuntimeEnv, mergeRuntimeEnv } from './agent-runtime-env'

function runtimeStatus(shell: ShellEnvironmentStatus): RuntimeStatus {
  return { shell } as RuntimeStatus
}

const gitBash: GitBashStatus = {
  available: true,
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  version: '5.2.37',
  error: null,
}

const wsl: WslStatus = {
  available: true,
  version: 2,
  defaultDistro: 'Ubuntu-24.04',
  distros: ['Ubuntu-24.04'],
  error: null,
}

const bothShells = runtimeStatus({ gitBash, wsl, recommended: 'git-bash' })

describe('Agent Windows Shell 运行环境', () => {
  test('Given 新版 Copis CLI 路径 When 构建子进程环境 Then 同时提供旧版 CLI 兼容别名', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '/Applications/Copis.app/Contents/Resources/bin/copis',
      platform: 'darwin',
      processEnv: {},
    })

    expect(result.env).toMatchObject({
      COPIS_CLI: '/Applications/Copis.app/Contents/Resources/bin/copis',
      PROMA_CLI: '/Applications/Copis.app/Contents/Resources/bin/copis',
    })
  })

  test('Given Git Bash 与 WSL 均可用 When 使用默认策略 Then 优先使用 Git Bash', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      runtimeStatus: bothShells,
    })

    expect(result).toMatchObject({
      shellKind: 'git-bash',
      shellPath: gitBash.path,
      env: {
        COPIS_WINDOWS_SHELL: 'git-bash',
      },
    })
  })

  test('Given Git Bash 与 WSL 均可用 When 用户显式选择 WSL Then 使用 WSL', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      runtimeStatus: bothShells,
      windowsShellPreference: 'wsl',
    })

    expect(result).toMatchObject({
      shellKind: 'wsl',
      wslCommand: 'wsl.exe',
      wslDistro: 'Ubuntu-24.04',
      env: {
        COPIS_WINDOWS_SHELL: 'wsl',
        COPIS_WSL_DISTRO: 'Ubuntu-24.04',
      },
    })
  })

  test('Given WSL 首选项不可用 When Git Bash 可用 Then 回退到 Git Bash', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      platform: 'win32',
      processEnv: {},
      windowsShellPreference: 'wsl',
      runtimeStatus: runtimeStatus({
        gitBash,
        wsl: { ...wsl, available: false, version: null, defaultDistro: null, distros: [], error: '未安装' },
        recommended: 'git-bash',
      }),
    })

    expect(result.shellKind).toBe('git-bash')
    expect(result.shellPath).toBe(gitBash.path!)
  })

  test('Given Windows Path 大小写不同 When 合并运行环境 Then 仅保留覆盖后的 PATH', () => {
    const result = mergeRuntimeEnv(
      { Path: 'C:\\Windows\\System32' },
      { PATH: 'C:\\Copis;C:\\Windows\\System32' },
    )

    expect(result).toEqual({ PATH: 'C:\\Copis;C:\\Windows\\System32' })
  })

  test('Given OfficeCLI 功能模块已安装 When 构建 Agent 环境 Then 注入模块命令和 PATH', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      officeCliPath: '/Users/test/.copis/modules/versions/officecli/1.0.143/bin/officecli',
      platform: 'darwin',
      processEnv: {},
    } as Parameters<typeof buildAgentRuntimeEnv>[0])

    expect(result.env).toMatchObject({
      COPIS_OFFICECLI: '/Users/test/.copis/modules/versions/officecli/1.0.143/bin/officecli',
      PATH: '/Users/test/.copis/modules/versions/officecli/1.0.143/bin',
    })
  })

  test('Given Python runtime 功能模块已安装 When 构建 Agent 环境 Then Python bin 优先于系统 PATH', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      pythonRuntimePath: '/Users/test/.copis/modules/versions/python-runtime/3.12.14/bin/python',
      platform: 'darwin',
      processEnv: { PATH: '/usr/bin:/bin' },
    })

    expect(result.env).toMatchObject({
      COPIS_PYTHON_RUNTIME_ROOT: '/Users/test/.copis/modules/versions/python-runtime/3.12.14',
      PYTHONHOME: '/Users/test/.copis/modules/versions/python-runtime/3.12.14',
      PATH: '/Users/test/.copis/modules/versions/python-runtime/3.12.14/bin:/usr/bin:/bin',
    })
  })

  test('Given Windows Python runtime 入口 When 构建 Agent 环境 Then Python home 指向 bin 目录', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      pythonRuntimePath: 'C:\\Copis\\modules\\python-runtime\\bin\\python.exe',
      platform: 'win32',
      pathDelimiter: ';',
      processEnv: { Path: 'C:\\Windows\\System32' },
    })

    expect(result.env).toMatchObject({
      COPIS_PYTHON_RUNTIME_ROOT: 'C:\\Copis\\modules\\python-runtime\\bin',
      PYTHONHOME: 'C:\\Copis\\modules\\python-runtime\\bin',
      Path: 'C:\\Copis\\modules\\python-runtime\\bin;C:\\Windows\\System32',
    })
  })

  test('Given Dashi PPT 运行时配置 When 构建 Agent 环境 Then 注入 Dashi 相关环境变量', () => {
    const result = buildAgentRuntimeEnv({
      bundledCliPath: '',
      dashiPptRoot: '/Users/test/.copis/default-skills/dashi-ppt',
      dashiPptProjectRoot: '/Users/test/.copis/default-skills/dashi-ppt/project',
      nodeModulesRoot: '/Users/test/.copis/modules/node-runtime/node_modules',
      playwrightCoreEntrypoint: '/Users/test/.copis/modules/playwright-core/index.js',
      chromiumHeadlessShell: '/Users/test/.cache/ms-playwright/chromium_headless_shell-1100/chrome-mac/headless_shell',
      platform: 'darwin',
      processEnv: {},
    })

    expect(result.env).toMatchObject({
      COPIS_DASHI_PPT_ROOT: '/Users/test/.copis/default-skills/dashi-ppt',
      COPIS_DASHI_PPT_PROJECT_ROOT: '/Users/test/.copis/default-skills/dashi-ppt/project',
      COPIS_NODE_MODULES_ROOT: '/Users/test/.copis/modules/node-runtime/node_modules',
      COPIS_PLAYWRIGHT_CORE_ENTRY: '/Users/test/.copis/modules/playwright-core/index.js',
      COPIS_PLAYWRIGHT_HEADLESS_SHELL: '/Users/test/.cache/ms-playwright/chromium_headless_shell-1100/chrome-mac/headless_shell',
    })
  })
})
