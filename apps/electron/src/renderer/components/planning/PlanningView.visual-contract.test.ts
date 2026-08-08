import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const viewSource = readFileSync(new URL('./PlanningView.tsx', import.meta.url), 'utf8')
const globalStyles = readFileSync(new URL('../../styles/globals.css', import.meta.url), 'utf8')

describe('日程表新建按钮视觉契约', () => {
  test('Given 日程表 When 渲染新建日程按钮 Then 隐藏快捷键提示但保留快捷键行为和 ui-primary 配色', () => {
    expect(viewSource).not.toContain('ShortcutKeycaps')
    expect(viewSource).not.toContain('CreateShortcutHint')
    expect(viewSource).toContain("useShortcut('new-session'")
    expect(viewSource).toContain('aria-keyshortcuts="Meta+N Control+N"')
    expect(viewSource).toContain('ui-primary-button')
    expect(globalStyles).toContain('.ui-primary-button')
    expect(globalStyles).toContain('background-color: var(--ui-primary-background)')
    expect(globalStyles).toContain('color: var(--ui-primary)')
    expect(globalStyles).not.toContain('color: var(--ui-primary-foreground)')
    expect(globalStyles).toContain('.ui-primary-button:hover')
    expect(globalStyles).toContain('.ui-primary-button:focus-visible')
  })
})
