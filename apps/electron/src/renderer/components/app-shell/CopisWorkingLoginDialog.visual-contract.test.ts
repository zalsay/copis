import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dialogStyles = readFileSync(join(import.meta.dir, 'CopisWorkingLoginDialog.css'), 'utf8')
const globalStyles = readFileSync(join(import.meta.dir, '../../styles/globals.css'), 'utf8')

function ruleBody(selector: string): string {
  return dialogStyles.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? ''
}

describe('Working 登录弹窗视觉契约', () => {
  test('Given 登录弹窗 When 使用强调色 Then 读取全局 ui-primary 语义变量', () => {
    expect(globalStyles).toMatch(/--ui-primary:\s*#(f09a43|f3af6b);/)
    expect(globalStyles).toMatch(/--ui-primary-background:\s*rgb\(240 161 90 \/ (10%|20%)\);/)
    expect(globalStyles).toContain('--ui-primary-foreground: #2b2137;')

    expect(dialogStyles).toContain('outline: 2px solid var(--ui-primary)')
    expect(dialogStyles).toContain('color-mix(in srgb, var(--ui-primary) 22%, transparent)')
    expect(dialogStyles).not.toContain('#c8a7ff')
    expect(dialogStyles).not.toContain('#d5bdff')
    expect(dialogStyles).not.toContain('#21182c')
    expect(dialogStyles).not.toContain('rgba(200, 167, 255')
  })

  test('Given 登录弹窗 When 查看主操作与状态标记 Then 使用 primary 和 primary-foreground', () => {
    const checkRule = ruleBody('\\.copis-working-auth-check')
    const submitRule = ruleBody('\\.copis-working-auth-submit')

    expect(checkRule).toContain('background: var(--ui-primary)')
    expect(checkRule).toContain('color: var(--ui-primary-foreground)')
    expect(submitRule).toContain('border: 1px solid color-mix(in srgb, var(--ui-primary) 30%, transparent)')
    expect(submitRule).toContain('background: var(--ui-primary)')
    expect(submitRule).toContain('color: var(--ui-primary-foreground)')
    expect(dialogStyles).toContain('.copis-working-auth-submit:hover:not(:disabled)')
    expect(dialogStyles).toContain('filter: brightness(1.08)')
  })
})
