import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const messageSource = readFileSync(join(import.meta.dir, 'message.tsx'), 'utf8')
const reasoningSource = readFileSync(join(import.meta.dir, 'reasoning.tsx'), 'utf8')
const askUserBannerSource = readFileSync(join(import.meta.dir, '..', 'agent', 'AskUserBanner.tsx'), 'utf8')
const openLinkSource = readFileSync(join(import.meta.dir, '..', '..', 'lib', 'open-link.ts'), 'utf8')

describe('Agent 回复链接在内嵌页签打开契约 (BDD)', () => {
  test('Given Agent 消息渲染组件 message.tsx When 点击 Markdown 链接 Then 调用 openLink 而非直接调用 openExternal', () => {
    expect(messageSource).toContain("import { openLink } from '@/lib/open-link'")
    expect(messageSource).toContain('void openLink(href)')
    expect(messageSource).not.toContain('window.electronAPI.openExternal(href)')
  })

  test('Given 思考推理组件 reasoning.tsx When 点击 Markdown 链接 Then 调用 openLink 而非直接调用 openExternal', () => {
    expect(reasoningSource).toContain("import { openLink } from '@/lib/open-link'")
    expect(reasoningSource).toContain('void openLink(href)')
    expect(reasoningSource).not.toContain('window.electronAPI.openExternal(href)')
  })

  test('Given 交互问答组件 AskUserBanner.tsx When 点击选项说明链接 Then 调用 openLink 打开页签', () => {
    expect(askUserBannerSource).toContain("import { openLink } from '@/lib/open-link'")
    expect(askUserBannerSource).toContain('void openLink(href)')
  })

  test('Given openLink 工具函数实现 When 处理网页链接 Then 优先创建并激活 Chromium 页签并在异常时回退', () => {
    expect(openLinkSource).toContain('window.electronAPI?.webTabs?.create')
    expect(openLinkSource).toContain('activate: true')
    expect(openLinkSource).toContain('window.electronAPI?.openExternal')
  })
})
