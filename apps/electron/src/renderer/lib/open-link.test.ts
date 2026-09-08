import { describe, expect, test, afterEach, mock } from 'bun:test'
import { openLink } from './open-link'

describe('openLink 工具函数契约与行为测试 (BDD)', () => {
  const originalWindow = (globalThis as any).window

  afterEach(() => {
    ;(globalThis as any).window = originalWindow
  })

  test('Given 空链接或空字符串 When 调用 openLink Then 不触发任何 API 调用', async () => {
    const createMock = mock(() => Promise.resolve({ tabs: [], activeTabId: null }))
    const openExternalMock = mock(() => Promise.resolve())

    ;(globalThis as any).window = {
      electronAPI: {
        webTabs: { create: createMock },
        openExternal: openExternalMock,
      },
    }

    await openLink(null)
    await openLink(undefined)
    await openLink('')

    expect(createMock).toHaveBeenCalledTimes(0)
    expect(openExternalMock).toHaveBeenCalledTimes(0)
  })

  test('Given http/https 链接且 webTabs 可用 When 调用 openLink Then 优先在应用内页签中打开且 activate 为 true', async () => {
    const createMock = mock(() => Promise.resolve({ tabs: [], activeTabId: 'tab-1' }))
    const openExternalMock = mock(() => Promise.resolve())

    ;(globalThis as any).window = {
      electronAPI: {
        webTabs: { create: createMock },
        openExternal: openExternalMock,
      },
    }

    await openLink('https://example.com/docs')

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock).toHaveBeenCalledWith({ url: 'https://example.com/docs', activate: true })
    expect(openExternalMock).toHaveBeenCalledTimes(0)
  })

  test('Given http/https 链接但 webTabs.create 抛出异常 When 调用 openLink Then 优雅回退到系统浏览器', async () => {
    const createMock = mock(() => Promise.reject(new Error('webTabs 不可用')))
    const openExternalMock = mock(() => Promise.resolve())

    ;(globalThis as any).window = {
      electronAPI: {
        webTabs: { create: createMock },
        openExternal: openExternalMock,
      },
    }

    await openLink('https://example.com/fallback')

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith('https://example.com/fallback')
  })

  test('Given http/https 链接但环境中无 webTabs 接口 When 调用 openLink Then 直接回退到系统浏览器', async () => {
    const openExternalMock = mock(() => Promise.resolve())

    ;(globalThis as any).window = {
      electronAPI: {
        openExternal: openExternalMock,
      },
    }

    await openLink('http://localhost:3000')

    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith('http://localhost:3000')
  })

  test('Given mailto 协议链接 When 调用 openLink Then 直接调用 openExternal 打开外部客户端', async () => {
    const createMock = mock(() => Promise.resolve({ tabs: [], activeTabId: 'tab-1' }))
    const openExternalMock = mock(() => Promise.resolve())

    ;(globalThis as any).window = {
      electronAPI: {
        webTabs: { create: createMock },
        openExternal: openExternalMock,
      },
    }

    await openLink('mailto:support@example.com')

    expect(createMock).toHaveBeenCalledTimes(0)
    expect(openExternalMock).toHaveBeenCalledTimes(1)
    expect(openExternalMock).toHaveBeenCalledWith('mailto:support@example.com')
  })
})
