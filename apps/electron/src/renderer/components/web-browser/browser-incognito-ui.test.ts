import { describe, expect, test } from 'bun:test'
import type { WebTabState } from '@copis/shared'
import { getIncognitoActionState } from './browser-incognito-ui'

function tab(overrides: Partial<WebTabState> = {}): WebTabState {
  return {
    id: 'web-test',
    title: '新标签页',
    url: 'about:blank',
    faviconUrl: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isIncognito: false,
    canActivateIncognito: true,
    ...overrides,
  }
}

describe('无痕页签地址栏状态', () => {
  test('Given Copis 首页 When 获取无痕入口状态 Then 不显示入口', () => {
    expect(getIncognitoActionState(null)).toEqual({
      visible: false,
      disabled: true,
      active: false,
      label: '无痕模式',
      description: 'Copis 首页不支持无痕页签',
    })
  })

  test('Given 从未访问地址的普通空白页签 When 获取无痕入口状态 Then 可以激活', () => {
    expect(getIncognitoActionState(tab())).toEqual({
      visible: true,
      disabled: false,
      active: false,
      label: '启用无痕模式',
      description: '启用后使用独立的临时浏览会话',
    })
  })

  test('Given 普通页签已经访问过地址 When 获取无痕入口状态 Then 禁用并提示新建空白页签', () => {
    expect(getIncognitoActionState(tab({ url: 'https://example.com', canActivateIncognito: false }))).toEqual({
      visible: true,
      disabled: true,
      active: false,
      label: '无法启用无痕模式',
      description: '当前页签已打开过地址，请新建空白页签后再启用无痕模式',
    })
  })

  test('Given 无痕页签 When 获取无痕入口状态 Then 显示激活态且不能回切', () => {
    expect(getIncognitoActionState(tab({ isIncognito: true, canActivateIncognito: false }))).toEqual({
      visible: true,
      disabled: true,
      active: true,
      label: '无痕模式已启用',
      description: '当前页签使用独立的临时浏览会话',
    })
  })
})
