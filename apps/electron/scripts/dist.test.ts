import { describe, expect, test } from 'bun:test'

const dist = await import('./dist')
const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json() as { scripts: Record<string, string> }

describe('visual distribution build plan', () => {
  test('Given visual/fast/debug 发布 When 对比标准 build Then 必须包含全部构建步骤且无需编译 Chrome 独立模块', () => {
    const standard = packageJson.scripts.build.split(' && ').map(step => step.replace(/^bun run /, ''))
    for (const variant of ['visual', 'fast', 'debug'] as const) {
      const commands = dist.getVisualDistributionBuildPlan(variant).map(step => step.command)
      expect(commands).toEqual([...standard, 'sync:runtime-deps', 'electron-builder'])
      expect(commands).not.toContain('build:chrome-desktop-helper')
    }
  })

  test('all visual variants build both preloads before renderer and electron-builder', () => {
    const plan = dist.createVisualDistributionBuildPlan()

    expect(plan.map((step) => step.command)).toEqual([
      'build:dsh-creation-web',
      'build:main',
      'build:preload',
      'build:web-javascript-prompt-preload',
      'build:dsh-bridge-preload',
      'build:agent-rpc-worker',
      'build:renderer',
      'build:cli',
      'copy:pi-extensions',
      'build:resources',
      'sync:runtime-deps',
      'electron-builder',
    ])

    for (const variant of ['visual', 'fast', 'debug'] as const) {
      expect(dist.getVisualDistributionBuildPlan(variant)).toEqual(plan)
    }

    const rendererIndex = plan.findIndex((step) => step.command === 'build:renderer')
    const builderIndex = plan.findIndex((step) => step.command === 'electron-builder')
    expect(plan.findIndex((step) => step.command === 'build:preload')).toBeLessThan(rendererIndex)
    expect(plan.findIndex((step) => step.command === 'build:web-javascript-prompt-preload')).toBeLessThan(rendererIndex)
    expect(plan.findIndex((step) => step.command === 'build:preload')).toBeLessThan(builderIndex)
    expect(plan.findIndex((step) => step.command === 'build:web-javascript-prompt-preload')).toBeLessThan(builderIndex)
  })
})

describe('visual distribution direct run', () => {
  const expectedBuildCommands = [
    'build:dsh-creation-web',
    'build:main',
    'build:preload',
    'build:web-javascript-prompt-preload',
    'build:dsh-bridge-preload',
    'build:agent-rpc-worker',
    'build:renderer',
    'build:cli',
    'copy:pi-extensions',
    'build:resources',
    'sync:runtime-deps',
    'electron-builder',
  ]

  function runDirect(args: string[], failedBuildCommand?: string) {
    const calls: string[] = []
    const verboseModes: boolean[] = []
    let builderEnv: Record<string, string> | undefined
    const results = dist.runVisualDistributionBuild(args, (name, command, commandArgs, options) => {
      const invocation = [command, ...commandArgs].join(' ')
      calls.push(invocation)
      verboseModes.push(options.verbose)
      if (commandArgs[0] === 'scripts/package-electron-builder.ts') builderEnv = options.env
      return {
        name,
        duration: 0,
        success: !commandArgs.includes(failedBuildCommand ?? '__never_fail__'),
        skipped: false,
      }
    })
    return { calls, results, verboseModes, builderEnv }
  }

  for (const [variant, args] of [
    ['visual', []],
    ['fast', ['--current-arch', '--dmg']],
    ['debug', ['--current-arch', '--verbose']],
  ] as const) {
    test(`direct ${variant} entry executes both preloads before later build steps`, () => {
      const beforeDebug = process.env.DEBUG
      const { calls, results, verboseModes, builderEnv } = runDirect([...args])

      expect(results.every((result) => result.success)).toBe(true)
      expect(calls).toHaveLength(expectedBuildCommands.length)
      expect(calls.map((call) => expectedBuildCommands.find((command) => call.includes(command)))).toEqual(
        expectedBuildCommands,
      )

      const preloadIndex = calls.findIndex((call) => call.includes('build:preload'))
      const promptPreloadIndex = calls.findIndex((call) =>
        call.includes('build:web-javascript-prompt-preload'),
      )
      const rendererIndex = calls.findIndex((call) => call.includes('build:renderer'))
      const builderIndex = calls.findIndex((call) => call.includes('electron-builder'))

      expect(preloadIndex).toBeLessThan(rendererIndex)
      expect(promptPreloadIndex).toBeLessThan(rendererIndex)
      expect(preloadIndex).toBeLessThan(builderIndex)
      expect(promptPreloadIndex).toBeLessThan(builderIndex)
      expect(process.env.DEBUG).toBe(beforeDebug)

      if (variant === 'fast') {
        expect(calls.at(-1)).toContain('--config.mac.target=dmg')
      }
      if (variant === 'debug') {
        expect(verboseModes.every(Boolean)).toBe(true)
        expect(builderEnv?.DEBUG).toBe('electron-builder,electron-builder:*')
      }
    })
  }

  for (const command of ['copy:pi-extensions', 'sync:runtime-deps']) {
    test(`Given ${command} 失败 When 发布 Then 不进入 electron-builder`, () => {
      const { calls, results } = runDirect(['--current-arch', '--dmg'], command)
      expect(results.at(-1)?.success).toBe(false)
      expect(calls.some(call => call.includes('scripts/package-electron-builder.ts'))).toBe(false)
    })
  }

  test('a normal preload failure stops before renderer and electron-builder', () => {
    const { calls, results } = runDirect([], 'build:preload')

    expect(results.at(-1)?.success).toBe(false)
    expect(calls).toHaveLength(3)
    expect(calls.at(-1)).toContain('build:preload')
  })

  test('a prompt preload failure stops before renderer and electron-builder', () => {
    const { calls, results } = runDirect([], 'build:web-javascript-prompt-preload')

    expect(results.at(-1)?.success).toBe(false)
    expect(calls).toHaveLength(4)
    expect(calls.at(-1)).toContain('build:web-javascript-prompt-preload')
  })
})
