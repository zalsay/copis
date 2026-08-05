import { describe, expect, test } from 'bun:test'
import { dirname } from 'node:path'
import {
  filterAttachedPaths,
  getAttachedFileDirectories,
  normalizeAttachedPaths,
  requireAttachedPath,
} from './attached-paths'

describe('Agent 附加路径', () => {
  test('Given 附加路径数组包含 undefined、null 和空字符串 When 计算文件父目录 Then 只处理有效字符串', () => {
    const paths: unknown[] = ['C:\\workspace\\note.md', undefined, null, '', '  ', 42]

    expect(getAttachedFileDirectories(paths)).toEqual([dirname('C:\\workspace\\note.md')])
  })

  test('Given IPC 或历史配置不是字符串数组 When 过滤附加路径 Then 返回空数组而不是抛出 path 异常', () => {
    expect(filterAttachedPaths(undefined)).toEqual([])
    expect(filterAttachedPaths(null)).toEqual([])
    expect(filterAttachedPaths({ path: 'C:\\workspace' })).toEqual([])
    expect(normalizeAttachedPaths([undefined, null, '', '  '])).toBeUndefined()
  })

  test('Given 附加路径为空 When 校验 IPC 输入 Then 返回明确的参数错误', () => {
    expect(() => requireAttachedPath(undefined, '附加文件路径')).toThrow('附加文件路径不正确')
    expect(() => requireAttachedPath('  ', '附加目录路径')).toThrow('附加目录路径不正确')
    expect(requireAttachedPath('C:\\workspace', '附加目录路径')).toBe('C:\\workspace')
  })
})
