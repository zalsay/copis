import { describe, expect, test } from 'bun:test'
import { ALLOWED_DASHI_DESIGN_SUBCOMMANDS } from './dashi-design'
import { getCommand } from '../registry'

// 注册
import './dashi-design'

describe('CLI dashi-design 命令分发', () => {
  const dashiDesignCmd = getCommand('dashi-design')

  test('dashi-design 命令已成功注册', () => {
    expect(dashiDesignCmd).toBeDefined()
    expect(dashiDesignCmd?.name).toBe('dashi-design')
  })

  test('包含完整的白名单子命令列表', () => {
    expect(ALLOWED_DASHI_DESIGN_SUBCOMMANDS).toContain('version')
    expect(ALLOWED_DASHI_DESIGN_SUBCOMMANDS).toContain('scaffold')
    expect(ALLOWED_DASHI_DESIGN_SUBCOMMANDS).toContain('export')
    expect(ALLOWED_DASHI_DESIGN_SUBCOMMANDS).toContain('validate')
    expect(ALLOWED_DASHI_DESIGN_SUBCOMMANDS).toContain('preview')
    expect(ALLOWED_DASHI_DESIGN_SUBCOMMANDS).toContain('check-latest-version')
  })

  test('version 子命令直接返回成功并输出版本号', async () => {
    const exitCode = await dashiDesignCmd!.run({
      rawArgs: ['version'],
      args: { positionals: ['version'], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(0)
  })

  test('check-latest-version 子命令直接返回成功', async () => {
    const exitCode = await dashiDesignCmd!.run({
      rawArgs: ['check-latest-version'],
      args: { positionals: ['check-latest-version'], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(0)
  })

  test('未知子命令返回 EXIT_USAGE (2)', async () => {
    const exitCode = await dashiDesignCmd!.run({
      rawArgs: ['unknown-subcommand'],
      args: { positionals: ['unknown-subcommand'], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(2)
  })

  test('无子命令参数返回 EXIT_USAGE (2)', async () => {
    const exitCode = await dashiDesignCmd!.run({
      rawArgs: [],
      args: { positionals: [], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(2)
  })
})
