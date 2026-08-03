import { describe, expect, test } from 'bun:test'
import { shouldShowProjectFileTreeEntry } from './file-tree-filter'

describe('项目文件树过滤', () => {
  test('Given 点开头的目录 When 构建项目文件树 Then 不展示该目录', () => {
    expect(shouldShowProjectFileTreeEntry('.git', true)).toBe(false)
    expect(shouldShowProjectFileTreeEntry('.idea', true)).toBe(false)
  })

  test('Given 点开头的文件 When 构建项目文件树 Then 保留该文件', () => {
    expect(shouldShowProjectFileTreeEntry('.gitignore', false)).toBe(true)
    expect(shouldShowProjectFileTreeEntry('README.md', false)).toBe(true)
  })
})
