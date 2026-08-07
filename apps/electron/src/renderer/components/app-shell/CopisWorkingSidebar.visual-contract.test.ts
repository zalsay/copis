import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sidebarStyles = readFileSync(join(import.meta.dir, 'CopisWorkingSidebar.css'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

describe('Working 侧边栏视觉契约', () => {
  test('Given Working footer When 检查账户图标标记 Then 使用 primary 背景与图标颜色', () => {
    const accountMarkRule = sidebarStyles.match(
      /\.copis-working-account-mark\s*\{([^}]*)\}/s,
    )?.[1]
    const rootRule = globalStyles.match(/:root\s*\{([^}]*)\}/s)?.[1]

    expect(accountMarkRule).toBeDefined()
    expect(rootRule).toBeDefined()
    expect(rootRule).toContain('--ui-primary: #f5c18e')
    expect(rootRule).toContain('--ui-primary-background: rgb(240 161 90 / 10%)')
    expect(rootRule).toContain('--ui-primary-foreground: #2b2137')
    expect(accountMarkRule).toContain('background: var(--ui-primary-background)')
    expect(accountMarkRule).toContain('color: var(--ui-primary)')
    expect(accountMarkRule).not.toContain('background: var(--ui-primary)')
    expect(accountMarkRule).not.toContain('color: var(--ui-primary-foreground)')
    expect(accountMarkRule).not.toContain('color: hsl(var(--primary))')
    expect(accountMarkRule).not.toContain('#c8a7ff')
  })
})
