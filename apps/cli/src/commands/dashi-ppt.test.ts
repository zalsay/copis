import { describe, expect, test } from 'bun:test'
import { ALLOWED_DASHI_SUBCOMMANDS } from './dashi-ppt'
import { getCommand } from '../registry'

// 注册
import './dashi-ppt'

describe('CLI dashi-ppt 命令分发', () => {
  const dashiCmd = getCommand('dashi-ppt')

  test('dashi-ppt 命令已成功注册', () => {
    expect(dashiCmd).toBeDefined()
    expect(dashiCmd?.name).toBe('dashi-ppt')
  })

  test('包含完整的白名单子命令列表', () => {
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('version')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('layout:query')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('inspect:layout')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('props:safe')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('goal:scaffold')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('media:stage')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('render')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('validate:goal-spec')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('validate:swiss')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('validate:goal-copy')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('validate:four-variant-quality')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('preview')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('export:pptx')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('export:pdf')
    expect(ALLOWED_DASHI_SUBCOMMANDS).toContain('check-latest-version')
  })

  test('version 子命令直接返回成功并输出版本号', async () => {
    const exitCode = await dashiCmd!.run({
      rawArgs: ['version'],
      args: { positionals: ['version'], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(0)
  })

  test('未知子命令返回 EXIT_USAGE (2)', async () => {
    const exitCode = await dashiCmd!.run({
      rawArgs: ['unknown-subcommand'],
      args: { positionals: ['unknown-subcommand'], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(2)
  })

  test('缺少子命令返回 EXIT_USAGE (2)', async () => {
    const exitCode = await dashiCmd!.run({
      rawArgs: [],
      args: { positionals: [], flags: {} },
      pathOpts: {},
      json: false,
    })
    expect(exitCode).toBe(2)
  })
})
