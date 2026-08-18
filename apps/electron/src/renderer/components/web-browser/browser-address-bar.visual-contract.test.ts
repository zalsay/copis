import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const surfaceSource = readFileSync(join(import.meta.dir, 'WebBrowserSurface.tsx'), 'utf8')

describe('浏览器地址栏视觉契约', () => {
  test('Given 地址栏包含无痕按钮 When 渲染按钮容器 Then 右侧内边距为 0', () => {
    expect(surfaceSource).toContain('pl-3 pr-0')
    expect(surfaceSource).not.toContain('px-3 shadow-xs focus-within:border-primary/50')
  })

  test('Given 无痕页签已激活 When 渲染地址栏按钮 Then 仅使用 ui-primary 图标颜色且不显示背景', () => {
    expect(surfaceSource).toContain("'size-7 shrink-0 rounded-sm hover:bg-transparent'")
    expect(surfaceSource).toContain("'text-[var(--ui-primary)] hover:text-[var(--ui-primary)]'")
    expect(surfaceSource).not.toContain('bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground')
  })

  test('Given 地址栏所在页签 When 渲染容器 Then 仅无痕模式使用 ui-primary-background', () => {
    expect(surfaceSource).toContain("activeTab.isIncognito ? 'bg-[var(--ui-primary-background)]' : 'bg-input-surface'")
    expect(surfaceSource).toContain('bg-[var(--ui-primary-background)]')
    expect(surfaceSource).toContain('bg-input-surface')
    expect(surfaceSource).not.toContain('focus-within:border-primary/50')
    expect(surfaceSource).not.toContain('focus-within:ring-2')
  })
})
