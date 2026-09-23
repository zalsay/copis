import { describe, expect, test } from 'bun:test'
import { buildWindowsAclArguments, buildWindowsFlushArguments, writeAllSync } from './durable-fs'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('durable filesystem platform adapters', () => {
  test('Given 当前用户 SID When 构造 Windows ACL 命令 Then 使用 SID、递归一次授权且不使用 USERNAME', () => {
    expect(buildWindowsAclArguments('C:\\snapshot', 'S-1-5-21-1-2-3-1001', false)).toEqual([
      'C:\\snapshot',
      '/inheritance:r',
      '/remove:g', '*S-1-1-0',
      '/remove:g', '*S-1-5-32-545',
      '/grant:r', 'S-1-5-21-1-2-3-1001:(OI)(CI)RX',
      '/T', '/C',
    ])
  })

  test('Given Windows 目录树 When 构造 flush 命令 Then 使用单个 PowerShell 递归脚本参数', () => {
    const args = buildWindowsFlushArguments('C:\\snapshot', true)
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args[3]).toContain('Get-ChildItem')
    expect(args.at(-1)).toBe('C:\\snapshot')
  })

  test('Given 文件描述符 When writeAllSync 写入 Then 完整写入所有字节', () => {
    const root = mkdtempSync(join(tmpdir(), 'copis-durable-fs-'))
    const file = join(root, 'payload')
    const fd = openSync(file, 'w')
    try {
      writeAllSync(fd, Buffer.from('payload'), '测试文件')
    } finally {
      closeSync(fd)
    }
    expect(readFileSync(file, 'utf8')).toBe('payload')
    rmSync(root, { recursive: true, force: true })
  })
})
