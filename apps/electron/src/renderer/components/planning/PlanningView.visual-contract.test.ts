import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const viewSource = readFileSync(new URL('./PlanningView.tsx', import.meta.url), 'utf8')
const globalStyles = readFileSync(new URL('../../styles/globals.css', import.meta.url), 'utf8')

describe('日程表新建按钮视觉契约', () => {
  test('Given 日程表 When 渲染新建日程按钮 Then 隐藏快捷键提示但保留快捷键行为，且配色与记忆新建按钮一致', () => {
    expect(viewSource).not.toContain('ShortcutKeycaps')
    expect(viewSource).not.toContain('CreateShortcutHint')
    expect(viewSource).toContain("useShortcut('new-session'")
    expect(viewSource).toContain('aria-keyshortcuts="Meta+N Control+N"')
    expect(viewSource).not.toContain('ui-primary-button')
    expect(viewSource).toContain('bg-primary')
    expect(viewSource).toContain('text-primary-foreground')
    expect(viewSource).toContain('hover:bg-primary/90')
  })
})
