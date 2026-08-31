import { describe, expect, test } from 'bun:test'
import {
  getFileEntryDisplayName,
  getWorkspaceFolderDisplayName,
} from './workspace-folder-mapping'

describe('工作区目录 Web 层名称映射', () => {
  test('Given browser 目录 When 获取映射名称 Then 返回 browser(AI 浏览器)', () => {
    expect(getWorkspaceFolderDisplayName('browser')).toBe('browser(AI 浏览器)')
  })

  test('Given project 目录 When 获取映射名称 Then 返回 project(项目开发)', () => {
    expect(getWorkspaceFolderDisplayName('project')).toBe('project(项目开发)')
  })

  test('Given 其他目录或文件 When 获取映射名称 Then 保持原名', () => {
    expect(getWorkspaceFolderDisplayName('src')).toBe('src')
    expect(getWorkspaceFolderDisplayName('package.json')).toBe('package.json')
  })

  test('Given 工作区根目录下的顶层目录 When 计算条目展示名称 Then 正确映射', () => {
    expect(
      getFileEntryDisplayName({ name: 'browser', isDirectory: true, scope: 'project' }, 0),
    ).toBe('browser(AI 浏览器)')
    expect(
      getFileEntryDisplayName({ name: 'project', isDirectory: true, scope: 'project' }, 0),
    ).toBe('project(项目开发)')
  })

  test('Given 非根目录或非目录文件 When 计算条目展示名称 Then 保持原名不映射', () => {
    // 子目录下的 browser / project 不应该被错误映射
    expect(
      getFileEntryDisplayName({ name: 'project', isDirectory: true, scope: 'project' }, 1),
    ).toBe('project')
    // 文件不应该被映射
    expect(
      getFileEntryDisplayName({ name: 'browser', isDirectory: false, scope: 'project' }, 0),
    ).toBe('browser')
    // session scope 根下的目录不属于工作区系统目录
    expect(
      getFileEntryDisplayName({ name: 'project', isDirectory: true, scope: 'session' }, 0),
    ).toBe('project')
  })
})
