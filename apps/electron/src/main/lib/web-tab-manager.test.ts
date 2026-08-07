import { describe, expect, mock, test } from 'bun:test'

// 仅提供最小 electron stub 以便加载 web-tab-manager 模块，
// 回归测试只针对纯状态 helper，不模拟 WebContentsView 事件。
mock.module('electron', () => ({
  BrowserWindow: class {},
  shell: {},
  WebContentsView: class {},
}))

const { resolveWebTabFaviconUrl } = await import('./web-tab-manager')

describe('网页页签 favicon 生命周期', () => {
  test('Given 收藏夹导航时 page-favicon-updated 先于 did-navigate 触发 When 导航提交 Then 不清空已更新的 favicon', () => {
    let favicon: string | null = resolveWebTabFaviconUrl(null, { type: 'loading-started' })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'favicon-updated', favicons: ['https://example.com/favicon.ico'] })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'navigation-committed' })
    expect(favicon).toBe('https://example.com/favicon.ico')
  })

  test('Given 页签已有 favicon When 开始下一次导航 Then 清空旧 favicon', () => {
    const favicon = resolveWebTabFaviconUrl('https://old.example.com/favicon.ico', { type: 'loading-started' })
    expect(favicon).toBeNull()
  })

  test('Given 常规时序 favicon-updated 晚于 did-navigate When 图标到达 Then 设置新 favicon', () => {
    let favicon: string | null = resolveWebTabFaviconUrl(null, { type: 'loading-started' })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'navigation-committed' })
    favicon = resolveWebTabFaviconUrl(favicon, { type: 'favicon-updated', favicons: ['data:image/png;base64,AAAA'] })
    expect(favicon).toBe('data:image/png;base64,AAAA')
  })

  test('Given 页面没有 favicon When 导航提交 Then favicon 保持为空', () => {
    const favicon = resolveWebTabFaviconUrl(null, { type: 'navigation-committed' })
    expect(favicon).toBeNull()
  })
})
